import type { Message } from '@chitchak/protocol';
import { Permission, has } from '@chitchak/protocol';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { channels, messages } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import {
  attachToMessage,
  forMessages,
  type SerializedAttachment,
} from './attachments.js';
import { requireChannelAccess, type ChannelAccess } from './permissions.js';

/**
 * Who a message event goes to.
 *
 * Guild channels fan out to the guild; a DM goes to exactly two people. Every
 * write path returns one of these instead of a guild id, so the caller cannot
 * accidentally publish a private conversation to a guild - there is no guild id
 * to reach for.
 */
export type Audience =
  | { kind: 'guild'; guildId: string }
  | { kind: 'dm'; userIds: [string, string] };

function audienceOf(access: ChannelAccess, userId: string): Audience {
  return access.kind === 'guild'
    ? { kind: 'guild', guildId: access.guildId }
    : { kind: 'dm', userIds: [userId, access.otherId] };
}

const MAX_MESSAGE_LENGTH = 4000;
/** Matches what the composer will let somebody stage before sending. */
const MAX_ATTACHMENTS = 10;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function toMessage(
  row: typeof messages.$inferSelect,
  files: SerializedAttachment[] = [],
): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    attachments: files,
  };
}

/**
 * Attaches the files to a page of messages in one query rather than per row.
 *
 * History is read fifty at a time, and asking per message is fifty round trips
 * to save writing this.
 */
async function withAttachments(rows: Array<typeof messages.$inferSelect>): Promise<Message[]> {
  const grouped = await forMessages(rows.map((row) => row.id));
  return rows.map((row) => toMessage(row, grouped.get(row.id) ?? []));
}

export async function createMessage(input: {
  authorId: string;
  channelId: unknown;
  content: unknown;
  attachmentIds?: unknown;
}): Promise<{ message: Message; audience: Audience }> {
  if (typeof input.channelId !== 'string') throw errors.invalid('channelId is required');
  if (typeof input.content !== 'string') throw errors.invalid('content is required');

  const attachmentIds =
    Array.isArray(input.attachmentIds) && input.attachmentIds.every((id) => typeof id === 'string')
      ? (input.attachmentIds as string[])
      : [];
  if (attachmentIds.length > MAX_ATTACHMENTS) {
    throw errors.invalid(`A message can carry at most ${MAX_ATTACHMENTS} files`);
  }

  const content = input.content.trim();
  // A message that is only files is a real message. The emptiness rule is about
  // sending nothing at all, and a picture is not nothing.
  if (content.length === 0 && attachmentIds.length === 0) {
    throw errors.invalid('Message cannot be empty');
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw errors.invalid(`Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`);
  }

  const channel = await db.query.channels.findFirst({ where: eq(channels.id, input.channelId) });
  if (!channel) throw errors.notFound('No such channel');
  if (channel.kind !== 'text') throw errors.invalid('That channel does not accept messages');

  const access = await requireChannelAccess(
    input.channelId,
    input.authorId,
    Permission.SEND_MESSAGES,
    'You do not have permission to speak in that channel',
  );

  const [row] = await db
    .insert(messages)
    .values({ id: generateId(), channelId: channel.id, authorId: input.authorId, content })
    .returning();
  if (!row) throw errors.invalid('Could not save message');

  // Claimed after the message exists, and only rows this person uploaded and
  // has not already used - which is what stops a message carrying a file
  // somebody was merely told the id of.
  await attachToMessage(attachmentIds, row.id, input.authorId);
  const files = attachmentIds.length > 0 ? (await forMessages([row.id])).get(row.id) ?? [] : [];

  return { message: toMessage(row, files), audience: audienceOf(access, input.authorId) };
}

/**
 * Newest-first history, paged by cursor rather than by offset.
 *
 * A cursor is an index range scan instead of counting past N rows, and it stays
 * correct while people are posting - an OFFSET shifts under you every time a
 * new message arrives, silently duplicating or skipping a row per page.
 *
 * The cursor is `(created_at, id)`, not `id` alone. Ids are snowflakes stored as
 * text, and `'9...' < '10...'` lexicographically even though 9 < 10 - so an
 * id-only comparison would break the day ids gain a digit.
 */
export async function listMessages(input: {
  userId: string;
  channelId: string;
  before?: string | undefined;
  limit?: number | undefined;
}): Promise<Message[]> {
  await requireChannelAccess(input.channelId, input.userId, Permission.VIEW_CHANNEL);

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  // Resolve the cursor message to its timestamp. One primary-key lookup, and it
  // keeps the public API a plain `?before=<messageId>`.
  let cursor: { createdAt: Date; id: string } | null = null;
  if (input.before) {
    const anchor = await db.query.messages.findFirst({ where: eq(messages.id, input.before) });
    if (anchor && anchor.channelId === input.channelId) {
      cursor = { createdAt: anchor.createdAt, id: anchor.id };
    }
  }

  const rows = await db
    .select()
    .from(messages)
    .where(
      cursor
        ? and(
            eq(messages.channelId, input.channelId),
            sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}, ${cursor.id})`,
          )
        : eq(messages.channelId, input.channelId),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);

  // Return oldest-first: the client renders top to bottom and should not have
  // to reverse a list on every page load.
  return withAttachments(rows.reverse());
}

/** How many results one search returns. Deliberately smaller than a history page. */
const SEARCH_PAGE_SIZE = 25;
const MAX_SEARCH_PAGE_SIZE = 50;

/**
 * Find messages in one channel.
 *
 * One channel at a time, on purpose. Searching a whole server sounds more
 * useful than it is: results from channels you half-remember, in a list where
 * every row has to explain where it came from. Searching where you already are
 * is the thing people actually do, and it is a single index lookup rather than
 * a permission check per channel per query.
 *
 * `websearch_to_tsquery` rather than `to_tsquery`, for two reasons. It takes
 * what a person would type - quoted phrases, `or`, a leading `-` to exclude -
 * without any of it having to be explained. And it cannot be made to throw:
 * `to_tsquery` raises a syntax error on input as ordinary as `c++` or a bare
 * `&`, which in a search box means someone typing normally gets a 500.
 */
export async function searchMessages(input: {
  userId: string;
  channelId: string;
  query: string;
  authorId?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
}): Promise<Message[]> {
  // The same check the channel's history goes through. Search must never be a
  // way to read a channel you cannot open.
  await requireChannelAccess(input.channelId, input.userId, Permission.VIEW_CHANNEL);

  const query = input.query.trim();
  // An empty box is not a search for everything - but "everything this person
  // said here" is a real question, so an author on its own is enough to ask.
  if (query.length === 0 && !input.authorId) return [];

  const limit = Math.min(Math.max(input.limit ?? SEARCH_PAGE_SIZE, 1), MAX_SEARCH_PAGE_SIZE);

  let cursor: { createdAt: Date; id: string } | null = null;
  if (input.before) {
    const anchor = await db.query.messages.findFirst({ where: eq(messages.id, input.before) });
    if (anchor && anchor.channelId === input.channelId) {
      cursor = { createdAt: anchor.createdAt, id: anchor.id };
    }
  }

  const filters = [sql`channel_id = ${input.channelId}`];
  if (query.length > 0) {
    // Spelled exactly as the index expression in 0009_message_search.sql. Any
    // difference here - a different dictionary, a cast - and Postgres cannot
    // use the index and reads every message in the channel instead.
    filters.push(
      sql`to_tsvector('english', content) @@ websearch_to_tsquery('english', ${query})`,
    );
  }
  if (input.authorId) filters.push(sql`author_id = ${input.authorId}`);
  if (cursor) {
    // The timestamp goes in as an ISO string with an explicit cast. A Date
    // inside a raw fragment reaches the driver as a Date, which it cannot bind,
    // and the rejection is thrown from deep inside the connection.
    filters.push(
      sql`(created_at, id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id})`,
    );
  }

  /**
   * The match is materialised before anything is sorted, and that is the whole
   * point of writing this by hand.
   *
   * Left as one flat query, Postgres walks the channel backwards through time
   * and tests each message as it goes, because it has no way to estimate how
   * many messages match a text search and assumes it will fill a page quickly.
   * For a common word it is right and the query is instant. For a rare one -
   * which is what people actually search for - it is wrong, and it reads the
   * entire channel: measured at 200,000 messages, 491ms for a single hit, and
   * growing with the channel rather than with the number of results.
   *
   * Forcing the search to finish first costs the common case something and
   * saves the rare one an order of magnitude: the same two searches came out at
   * 48ms and 17ms. Both are imperceptible, and neither grows with the size of
   * the channel any more - only with the number of things actually found.
   */
  const rows = await db.execute<{
    id: string;
    channel_id: string;
    author_id: string;
    content: string;
    created_at: Date;
    edited_at: Date | null;
  }>(sql`
    with hits as materialized (
      select id from messages where ${sql.join(filters, sql` and `)}
    )
    select m.id, m.channel_id, m.author_id, m.content, m.created_at, m.edited_at
    from messages m join hits on hits.id = m.id
    order by m.created_at desc, m.id desc
    limit ${limit}
  `);

  // Search results are rendered by the same component as the channel, so they
  // carry their files too - a result whose whole content was a screenshot
  // would otherwise come back as a blank row.
  const grouped = await forMessages(rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
    editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
    attachments: grouped.get(row.id) ?? [],
  }));
}

/** Editing is author-only. No permission lets you rewrite someone else's words. */
export async function editMessage(input: {
  userId: string;
  messageId: string;
  content: string;
}): Promise<{ message: Message; audience: Audience }> {
  const existing = await db.query.messages.findFirst({ where: eq(messages.id, input.messageId) });
  if (!existing) throw errors.notFound('No such message');
  if (existing.authorId !== input.userId) {
    throw errors.forbidden('You can only edit your own messages');
  }

  const access = await requireChannelAccess(
    existing.channelId,
    input.userId,
    Permission.SEND_MESSAGES,
  );

  const content = input.content.trim();
  if (content.length === 0) throw errors.invalid('Message cannot be empty');
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw errors.invalid(`Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`);
  }

  const [row] = await db
    .update(messages)
    .set({ content, editedAt: new Date() })
    .where(eq(messages.id, input.messageId))
    .returning();
  if (!row) throw errors.notFound('No such message');

  // Editing changes the words, never the files - so they are re-read rather
  // than dropped, which is what returning a bare toMessage(row) would do.
  const files = (await forMessages([row.id])).get(row.id) ?? [];
  return { message: toMessage(row, files), audience: audienceOf(access, input.userId) };
}

/** Deleting your own needs nothing; deleting anyone else's needs MANAGE_MESSAGES. */
export async function deleteMessage(input: {
  userId: string;
  messageId: string;
}): Promise<{ channelId: string; messageId: string; audience: Audience }> {
  const existing = await db.query.messages.findFirst({ where: eq(messages.id, input.messageId) });
  if (!existing) throw errors.notFound('No such message');

  const isAuthor = existing.authorId === input.userId;
  const access = await requireChannelAccess(
    existing.channelId,
    input.userId,
    Permission.VIEW_CHANNEL,
  );

  // Manage messages is a guild power. In a DM there is nobody to moderate on
  // behalf of, so the rule is the simple one: your own messages, nothing else.
  const mayDeleteAnyones =
    access.kind === 'guild' && has(access.permissions, Permission.MANAGE_MESSAGES);
  if (!isAuthor && !mayDeleteAnyones) {
    throw errors.forbidden(
      access.kind === 'dm'
        ? 'You can only delete your own messages'
        : 'You need the Manage messages permission to delete that',
    );
  }

  await db.delete(messages).where(eq(messages.id, input.messageId));
  return {
    channelId: existing.channelId,
    messageId: existing.id,
    audience: audienceOf(access, input.userId),
  };
}
