import { GatewayCloseCode } from '@chitchak/protocol';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { staffActions, users } from '../db/schema.js';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { isPlatformStaff } from './staff.js';

/**
 * Locking somebody out of the platform, and letting them back in.
 *
 * The gap this fills: moderation was entirely per-server, so the only remedy
 * for someone behaving badly across servers - or in a server they own - was a
 * database query at three in the morning. This is that remedy, written down.
 *
 * Three things it deliberately is not:
 *
 *   - Not deletion. Nothing is erased. Servers, friends, messages and history
 *     are exactly as they were, and lifting a suspension gives all of it back.
 *     Every other remedy is irreversible, which is a bad property for the one
 *     that gets used when somebody is angry at two in the morning.
 *   - Not a guild ban. It is about the account, not about one room.
 *   - Not silent. The reason is shown to the person it happened to. An account
 *     that stops working without saying why is indistinguishable from a broken
 *     one, and somebody who cannot find out what they did cannot stop.
 *
 * A permanent removal is a suspension with no end date that nobody has lifted,
 * rather than a second state with its own rules to get wrong.
 */

/** Long enough to be a real sanction, short enough to be a mistake worth making. */
const MAX_DAYS = 3650;

export interface Suspension {
  /** When it started. */
  at: Date;
  /** When it ends, or null for indefinitely. */
  until: Date | null;
  reason: string;
}

/**
 * The suspension in force right now, or null.
 *
 * An expired one answers null rather than being cleared by a scheduled job, for
 * the same reason a lapsed subscription is: it is a question with an answer at
 * the moment somebody asks, so there is nothing to run overnight and nothing to
 * be out of date. The columns stay behind as a record that it happened.
 */
export function currentSuspension(row: {
  suspendedAt: Date | null;
  suspendedUntil: Date | null;
  suspendedReason: string | null;
}): Suspension | null {
  if (!row.suspendedAt) return null;
  if (row.suspendedUntil && row.suspendedUntil.getTime() <= Date.now()) return null;
  return {
    at: row.suspendedAt,
    until: row.suspendedUntil,
    reason: row.suspendedReason ?? 'No reason was recorded.',
  };
}

/** What to tell the person who is locked out. */
export function explain(suspension: Suspension): string {
  const until = suspension.until
    ? `until ${suspension.until.toISOString().slice(0, 10)}`
    : 'indefinitely';
  return `Your account is suspended ${until}. Reason: ${suspension.reason}`;
}

export interface SuspendInput {
  actorId: string;
  username: string;
  reason: string;
  /** Omitted or null for indefinitely. */
  days?: number | null;
}

export async function suspend(input: SuspendInput): Promise<{
  username: string;
  until: Date | null;
  reason: string;
}> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw errors.invalid('Say why - the person is shown this');
  if (reason.length > 500) throw errors.invalid('Keep the reason under 500 characters');

  if (input.days !== undefined && input.days !== null) {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_DAYS) {
      throw errors.invalid(`Length must be a whole number of days, 1 to ${MAX_DAYS}`);
    }
  }

  const target = await db.query.users.findFirst({
    where: eq(users.username, input.username.trim().toLowerCase()),
  });
  if (!target) throw errors.notFound(`Nobody here is called "${input.username}"`);
  if (target.deletedAt) throw errors.invalid('That account has been deleted');

  /*
    Staff cannot be suspended through the API.

    The staff list is an environment variable read at boot, so a suspended
    operator could not lift their own suspension and nobody else could reach
    the box any faster than they could. More to the point, an app that can lock
    out its own operators is one compromised session away from having none -
    and the honest way to remove an operator is to take them out of
    PLATFORM_ADMINS and redeploy, which is a decision with a paper trail.
  */
  if (isPlatformStaff(target.id)) throw errors.forbidden('Staff cannot be suspended from here');
  if (target.id === input.actorId) throw errors.invalid('You cannot suspend yourself');

  const now = new Date();
  const until = input.days ? new Date(now.getTime() + input.days * 24 * 60 * 60 * 1000) : null;

  // Written before the account is touched, so an action that half-fails still
  // leaves a record that it was attempted - see blackcard.ts for the same idea.
  await db.insert(staffActions).values({
    id: generateId(),
    actorId: input.actorId,
    action: 'suspend',
    subjectId: target.id,
    detail: `${until ? `${input.days} days, until ${until.toISOString()}` : 'indefinite'} - ${reason}`,
  });

  await db
    .update(users)
    .set({
      suspendedAt: now,
      suspendedUntil: until,
      suspendedReason: reason,
      /*
        Every existing session dies with the suspension.

        `tokensValidFrom` is already what invalidates access tokens issued
        before a moment, and it is read on every authenticated request. Without
        this, a suspended person keeps whatever access their current token has
        for up to fifteen minutes - which is exactly the window in which
        somebody who has just been suspended is most likely to use it.
      */
      tokensValidFrom: now,
    })
    .where(eq(users.id, target.id));

  /*
    And they are put off the socket they are sitting on.

    Bumping `tokensValidFrom` above ends every HTTP request, but a gateway
    connection authenticates once and then stays open. Without this a suspended
    person keeps talking in a voice channel while their API calls all fail,
    which is neither suspended nor working.
  */
  registry.closeUser(target.id, GatewayCloseCode.AuthenticationFailed, 'suspended');

  return { username: target.username, until, reason };
}

export async function lift(input: { actorId: string; username: string }): Promise<{
  username: string;
}> {
  const target = await db.query.users.findFirst({
    where: eq(users.username, input.username.trim().toLowerCase()),
  });
  if (!target) throw errors.notFound(`Nobody here is called "${input.username}"`);
  if (!target.suspendedAt) throw errors.invalid('That account is not suspended');

  await db.insert(staffActions).values({
    id: generateId(),
    actorId: input.actorId,
    action: 'suspend_lift',
    subjectId: target.id,
    detail: target.suspendedReason,
  });

  /*
    Cleared rather than back-dated.

    Leaving the reason behind would keep showing it to somebody who is no longer
    suspended. What actually happened stays in staff_actions, which is the
    record, and is the place to read it back from.
  */
  await db
    .update(users)
    .set({ suspendedAt: null, suspendedUntil: null, suspendedReason: null })
    .where(eq(users.id, target.id));

  return { username: target.username };
}

export interface SuspendedAccount {
  userId: string;
  username: string;
  displayName: string;
  at: string;
  until: string | null;
  reason: string;
}

/** Everyone currently locked out, newest first. */
export async function suspended(): Promise<SuspendedAccount[]> {
  const rows = await db.query.users.findMany({
    columns: {
      id: true,
      username: true,
      displayName: true,
      suspendedAt: true,
      suspendedUntil: true,
      suspendedReason: true,
    },
  });

  return rows
    .flatMap((row) => {
      const active = currentSuspension(row);
      if (!active) return [];
      return [
        {
          userId: row.id,
          username: row.username,
          displayName: row.displayName,
          at: active.at.toISOString(),
          until: active.until ? active.until.toISOString() : null,
          reason: active.reason,
        },
      ];
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
