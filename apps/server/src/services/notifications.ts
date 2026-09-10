import type { Message, Notification } from '@chitchak/protocol';
import { Permission } from '@chitchak/protocol';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, users } from '../db/schema.js';
import { generateId } from '../lib/ids.js';
import { blockExistsBetween } from './friends.js';
import { mentionedIds } from './messages.js';
import { requireChannelAccess } from './permissions.js';
import type { Audience } from './messages.js';

/**
 * The notifications inbox.
 *
 * Two things land here: a DM you have not read, and a message that mentioned
 * you. Both are a row in `notifications`, and the panel renders from that table
 * alone - the preview, the author and the guild are copied in when the row is
 * written, so an entry survives losing access to the channel it points at.
 */

/** How many entries the ready snapshot carries: every unread, then recent read ones. */
const SNAPSHOT_UNREAD_CAP = 100;
const SNAPSHOT_READ_CAP = 30;
/** History page size for the panel's "load more". */
const PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 50;

const PREVIEW_MAX = 140;

function toNotification(row: typeof notifications.$inferSelect): Notification {
  return {
    id: row.id,
    kind: row.kind === 'dm' ? 'dm' : 'mention',
    messageId: row.messageId,
    channelId: row.channelId,
    guildId: row.guildId,
    authorId: row.authorId,
    preview: row.preview,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}

/**
 * A plain-text snippet with `<@id>` swapped for `@Name`.
 *
 * Stored rather than resolved on read: the panel shows it next to a message
 * that may since have been edited or deleted, and "what it said when it pinged
 * you" is the useful thing to keep - the same reason a report quotes its
 * message instead of linking it.
 */
async function buildPreview(content: string): Promise<string> {
  const ids = mentionedIds(content);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, ids));
    for (const row of rows) names.set(row.id, row.displayName);
  }

  const resolved = content.replace(/<@(\d{1,20})>/g, (_whole, id: string) =>
    names.has(id) ? `@${names.get(id) ?? ''}` : '@unknown',
  );
  const flat = resolved.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

/**
 * Write the notifications one new message earns, and return the wire objects
 * so the gateway can push them.
 *
 * A DM message notifies the other person, kind `dm`. A guild message notifies
 * everyone it mentions who can actually see the channel and is not blocked
 * either way, kind `mention`. The author is never notified about their own
 * message, and a DM is never also a `mention` - the conversation already
 * surfaces it.
 */
export async function notifyForMessage(input: {
  message: Message;
  audience: Audience;
  guildId: string | null;
}): Promise<Array<{ userId: string; notification: Notification }>> {
  const { message, audience, guildId } = input;

  const recipients: string[] =
    audience.kind === 'dm'
      ? audience.userIds.filter((id) => id !== message.authorId)
      : await eligibleMentionRecipients(message, guildId);

  if (recipients.length === 0) return [];

  const kind = audience.kind === 'dm' ? 'dm' : 'mention';
  const preview = await buildPreview(message.content);
  const now = new Date();

  const rows = recipients.map((userId) => ({
    id: generateId(),
    userId,
    kind,
    messageId: message.id,
    channelId: message.channelId,
    guildId,
    authorId: message.authorId,
    preview,
    createdAt: now,
  }));

  const inserted = await db
    .insert(notifications)
    .values(rows)
    // The unique index is (user, message, kind); a retried delivery is a no-op
    // rather than a duplicate or an error.
    .onConflictDoNothing()
    .returning();

  return inserted.map((row) => ({ userId: row.userId, notification: toNotification(row) }));
}

/** Mentioned ids, minus the author, minus anyone blocked, minus anyone who cannot see the channel. */
async function eligibleMentionRecipients(
  message: Message,
  guildId: string | null,
): Promise<string[]> {
  if (!guildId) return [];
  const ids = mentionedIds(message.content).filter((id) => id !== message.authorId);
  if (ids.length === 0) return [];

  const checked = await Promise.all(
    ids.map(async (id) => {
      if (await blockExistsBetween(message.authorId, id)) return null;
      try {
        await requireChannelAccess(message.channelId, id, Permission.VIEW_CHANNEL);
        return id;
      } catch {
        // Not a member any more, or the channel is hidden from their rank.
        return null;
      }
    }),
  );
  return checked.filter((id): id is string => id !== null);
}

/** The inbox slice for the ready snapshot: every unread, then a few recent read. */
export async function notificationsFor(userId: string): Promise<Notification[]> {
  const [unread, read] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(SNAPSHOT_UNREAD_CAP),
    db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNotNull(notifications.readAt)))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(SNAPSHOT_READ_CAP),
  ]);

  // Both lists are already newest-first; merge them the same way, comparing the
  // pair the index is ordered by rather than the id alone.
  return [...unread, ...read]
    .sort((a, b) => {
      if (a.createdAt.getTime() !== b.createdAt.getTime()) {
        return b.createdAt.getTime() - a.createdAt.getTime();
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    })
    .map(toNotification);
}

/** Older entries, newest first, for the panel's "load more". */
export async function listNotifications(input: {
  userId: string;
  before?: string | undefined;
  limit?: number | undefined;
}): Promise<Notification[]> {
  const limit = Math.min(Math.max(input.limit ?? PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const conditions = [eq(notifications.userId, input.userId)];

  if (input.before) {
    // Resolve the cursor to its (created_at, id) so the comparison matches the
    // index order - an id-only compare breaks the day a snowflake gains a digit.
    const anchor = await db.query.notifications.findFirst({
      where: and(eq(notifications.id, input.before), eq(notifications.userId, input.userId)),
    });
    if (anchor) {
      conditions.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${anchor.createdAt.toISOString()}::timestamptz, ${anchor.id})`,
      );
    }
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);
  return rows.map(toNotification);
}

/**
 * Mark some notifications read, and return the ids that actually changed so the
 * caller can echo `notification:read` to the person's other devices.
 *
 * Only ever touches rows already unread and already this user's - so a stray id
 * from another account does nothing, and a second "mark all" is silent.
 */
export async function markNotificationsRead(input: {
  userId: string;
  all?: boolean | undefined;
  ids?: string[] | undefined;
  channelId?: string | undefined;
}): Promise<string[]> {
  const scope = [eq(notifications.userId, input.userId), isNull(notifications.readAt)];

  if (input.all) {
    // no extra filter
  } else if (input.ids && input.ids.length > 0) {
    scope.push(inArray(notifications.id, input.ids));
  } else if (input.channelId) {
    scope.push(eq(notifications.channelId, input.channelId));
  } else {
    return [];
  }

  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...scope))
    .returning({ id: notifications.id });

  return updated.map((row) => row.id);
}
