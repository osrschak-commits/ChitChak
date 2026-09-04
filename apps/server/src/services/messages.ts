import type { Message } from '@chitchak/protocol';
import { Permission, has } from '@chitchak/protocol';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { channels, messages } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { requireChannelPermission } from './permissions.js';

const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function toMessage(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  };
}

export async function createMessage(input: {
  authorId: string;
  channelId: unknown;
  content: unknown;
}): Promise<{ message: Message; guildId: string }> {
  if (typeof input.channelId !== 'string') throw errors.invalid('channelId is required');
  if (typeof input.content !== 'string') throw errors.invalid('content is required');

  const content = input.content.trim();
  if (content.length === 0) throw errors.invalid('Message cannot be empty');
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw errors.invalid(`Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`);
  }

  const channel = await db.query.channels.findFirst({ where: eq(channels.id, input.channelId) });
  if (!channel) throw errors.notFound('No such channel');
  if (channel.kind !== 'text') throw errors.invalid('That channel does not accept messages');

  await requireChannelPermission(
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

  return { message: toMessage(row), guildId: channel.guildId };
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
  await requireChannelPermission(input.channelId, input.userId, Permission.VIEW_CHANNEL);

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
  return rows.reverse().map(toMessage);
}

/** Editing is author-only. No permission lets you rewrite someone else's words. */
export async function editMessage(input: {
  userId: string;
  messageId: string;
  content: string;
}): Promise<{ message: Message; guildId: string }> {
  const existing = await db.query.messages.findFirst({ where: eq(messages.id, input.messageId) });
  if (!existing) throw errors.notFound('No such message');
  if (existing.authorId !== input.userId) {
    throw errors.forbidden('You can only edit your own messages');
  }

  const { guildId } = await requireChannelPermission(
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

  return { message: toMessage(row), guildId };
}

/** Deleting your own needs nothing; deleting anyone else's needs MANAGE_MESSAGES. */
export async function deleteMessage(input: {
  userId: string;
  messageId: string;
}): Promise<{ channelId: string; messageId: string; guildId: string }> {
  const existing = await db.query.messages.findFirst({ where: eq(messages.id, input.messageId) });
  if (!existing) throw errors.notFound('No such message');

  const isAuthor = existing.authorId === input.userId;
  const { guildId, permissions } = await requireChannelPermission(
    existing.channelId,
    input.userId,
    Permission.VIEW_CHANNEL,
  );

  if (!isAuthor && !has(permissions, Permission.MANAGE_MESSAGES)) {
    throw errors.forbidden('You need the Manage messages permission to delete that');
  }

  await db.delete(messages).where(eq(messages.id, input.messageId));
  return { channelId: existing.channelId, messageId: existing.id, guildId };
}
