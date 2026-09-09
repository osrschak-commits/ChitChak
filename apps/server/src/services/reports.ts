import { Permission } from '@chitchak/protocol';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { messages, reports, staffActions, users } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { requireChannelAccess } from './permissions.js';
import { isPlatformStaff } from './staff.js';

/**
 * Reporting somebody, and the queue staff work through.
 *
 * Before this there was no way for anyone to raise anything: the only remedies
 * were inside a server, held by that server's own owner, which is no use at all
 * when the owner is the problem. A report is how something reaches an operator
 * from someone who has never met one.
 *
 * The evidence is copied, not linked. A reported message is very often gone
 * within the minute - deleted by its author, or by the person being reported -
 * and a queue of rows pointing at nothing is a queue nobody can act on. What
 * staff read is the snapshot taken when the report was filed.
 */

const MAX_REASON = 1000;
const MIN_REASON = 5;

/** How much of a message is kept as evidence. Long enough to judge, short enough to store. */
const QUOTE_LIMIT = 2000;

/**
 * How many reports one person may file in a day.
 *
 * Reporting is a power ordinary users have over other users, so it is one that
 * can be abused - burying a real queue under noise is itself a way of getting
 * away with things. Generous for anybody acting in good faith.
 */
const DAILY_LIMIT = 20;

export type ReportStatus = 'open' | 'actioned' | 'dismissed';

export interface FileReportInput {
  reporterId: string;
  /** The reported message, when there is one. Its author becomes the subject. */
  messageId?: string | null;
  /** Reporting a person directly, with no particular message. */
  username?: string | null;
  reason: string;
}

export async function file(input: FileReportInput): Promise<{ id: string }> {
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON) throw errors.invalid('Say what is wrong with it');
  if (reason.length > MAX_REASON) throw errors.invalid('Keep it under 1000 characters');

  const [recent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reports)
    .where(
      and(
        eq(reports.reporterId, input.reporterId),
        gte(reports.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      ),
    );
  if ((recent?.count ?? 0) >= DAILY_LIMIT) {
    throw errors.rateLimited('You have reported a lot today. Try again tomorrow.');
  }

  const evidence = input.messageId
    ? await aboutMessage(input.messageId, input.reporterId)
    : await aboutPerson(input.username ?? '');

  if (evidence.subjectId === input.reporterId) {
    throw errors.invalid('You cannot report yourself');
  }

  /*
    Staff cannot be reported into a queue they are the only readers of.

    Not a protection for staff - it is that the report would do nothing. The
    queue is read by the person being reported, so filing it just tells them,
    and a reporter who thinks they have raised something when they have not is
    worse off than one who is told to take it elsewhere.
  */
  if (isPlatformStaff(evidence.subjectId)) {
    throw errors.invalid('Reports about operators have to go to them directly');
  }

  const id = generateId();
  try {
    await db.insert(reports).values({
      id,
      reporterId: input.reporterId,
      subjectId: evidence.subjectId,
      messageId: evidence.messageId,
      guildId: evidence.guildId,
      channelId: evidence.channelId,
      quoted: evidence.quoted,
      reason,
    });
  } catch (error: unknown) {
    // The unique index on (reporter, message). Reporting the same message twice
    // is almost always a double click, so it is answered as "already done"
    // rather than as a failure.
    if (isUniqueViolation(error)) throw errors.conflict('You have already reported that');
    throw error;
  }

  return { id };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

interface Evidence {
  subjectId: string;
  messageId: string | null;
  guildId: string | null;
  channelId: string | null;
  quoted: string | null;
}

async function aboutMessage(messageId: string, reporterId: string): Promise<Evidence> {
  const row = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
    with: { channel: true },
  });
  if (!row) throw errors.notFound('That message no longer exists');

  /*
    You can only report what you could read.

    Without this the endpoint is an oracle: hand it a message id you have no
    business knowing about, and it copies that message's text into the staff
    queue for you. Ids are 64-bit and not worth guessing at, which makes this
    a small hole - but "small hole that quotes private messages into a queue"
    is not a thing to leave open when the check is one call.

    VIEW_CHANNEL rather than anything stronger: reporting is not a privilege,
    it is what anybody who can see the message is entitled to do about it.
  */
  await requireChannelAccess(
    row.channelId,
    reporterId,
    Permission.VIEW_CHANNEL,
    'You cannot report a message you cannot see',
  );

  return {
    subjectId: row.authorId,
    messageId: row.id,
    guildId: row.channel?.guildId ?? null,
    channelId: row.channelId,
    quoted: row.content.slice(0, QUOTE_LIMIT),
  };
}

async function aboutPerson(username: string): Promise<Evidence> {
  const row = await db.query.users.findFirst({
    where: eq(users.username, username.trim().toLowerCase()),
  });
  if (!row || row.deletedAt) throw errors.notFound('No one with that username');
  return { subjectId: row.id, messageId: null, guildId: null, channelId: null, quoted: null };
}

export interface QueuedReport {
  id: string;
  at: string;
  status: ReportStatus;
  reason: string;
  quoted: string | null;
  reporter: string;
  subject: string;
  subjectId: string;
  /** Whether the reported account is currently locked out. */
  subjectSuspended: boolean;
  /** How many reports this person has, ever. Context the single row cannot give. */
  subjectReports: number;
  guildId: string | null;
  channelId: string | null;
  messageId: string | null;
  handledBy: string | null;
  handledAt: string | null;
  outcome: string | null;
}

/**
 * The queue.
 *
 * Open reports first and oldest first within that, because the thing that has
 * been waiting longest is the thing most likely to have been forgotten. Handled
 * ones stay visible underneath: a report that was dismissed is part of the
 * picture the next time the same name comes up.
 */
export async function queue(status?: ReportStatus): Promise<QueuedReport[]> {
  const rows = await db.query.reports.findMany({
    where: status ? eq(reports.status, status) : undefined,
    orderBy: [desc(reports.createdAt)],
    limit: 200,
    with: {
      reporter: { columns: { username: true } },
      subject: { columns: { id: true, username: true, suspendedAt: true, suspendedUntil: true } },
      handledBy: { columns: { username: true } },
    },
  });

  // One query for the per-person totals rather than one per row.
  const counts = new Map<string, number>();
  if (rows.length > 0) {
    const tallies = await db
      .select({ subjectId: reports.subjectId, count: sql<number>`count(*)::int` })
      .from(reports)
      .groupBy(reports.subjectId);
    for (const tally of tallies) counts.set(tally.subjectId, tally.count);
  }

  const ranked = rows.map((row) => ({
    id: row.id,
    at: row.createdAt.toISOString(),
    status: row.status as ReportStatus,
    reason: row.reason,
    quoted: row.quoted,
    reporter: row.reporter?.username ?? 'deleted user',
    subject: row.subject?.username ?? 'deleted user',
    subjectId: row.subjectId,
    subjectSuspended: Boolean(
      row.subject?.suspendedAt &&
        (!row.subject.suspendedUntil || row.subject.suspendedUntil.getTime() > Date.now()),
    ),
    subjectReports: counts.get(row.subjectId) ?? 1,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    handledBy: row.handledBy?.username ?? null,
    handledAt: row.handledAt ? row.handledAt.toISOString() : null,
    outcome: row.outcome,
  }));

  // Open first, then newest. Sorted here rather than in SQL because "open
  // before handled" is not an ordering the status column has on its own.
  return ranked.sort((a, b) => {
    if (a.status === 'open' && b.status !== 'open') return -1;
    if (b.status === 'open' && a.status !== 'open') return 1;
    return b.at.localeCompare(a.at);
  });
}

/** How many are waiting - for the badge on the staff tab. */
export async function openCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reports)
    .where(eq(reports.status, 'open'));
  return row?.count ?? 0;
}

export async function resolve(input: {
  actorId: string;
  reportId: string;
  status: 'actioned' | 'dismissed';
  outcome?: string | null;
}): Promise<QueuedReport> {
  const row = await db.query.reports.findFirst({ where: eq(reports.id, input.reportId) });
  if (!row) throw errors.notFound('No such report');

  const outcome = input.outcome?.trim() || null;
  if (outcome && outcome.length > MAX_REASON) throw errors.invalid('Keep it under 1000 characters');

  await db.insert(staffActions).values({
    id: generateId(),
    actorId: input.actorId,
    action: `report_${input.status}`,
    subjectId: row.subjectId,
    detail: outcome,
  });

  await db
    .update(reports)
    .set({
      status: input.status,
      handledById: input.actorId,
      handledAt: new Date(),
      outcome,
    })
    .where(eq(reports.id, input.reportId));

  const [updated] = (await queue()).filter((entry) => entry.id === input.reportId);
  if (!updated) throw errors.notFound('No such report');
  return updated;
}
