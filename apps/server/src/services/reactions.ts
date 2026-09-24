import type { Reaction } from '@chitchak/protocol';
import { Permission } from '@chitchak/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { guildEmoji, messageReactions, messages } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { requireChannelAccess, type ChannelAccess } from './permissions.js';
import type { Audience } from './messages.js';

/**
 * Reacting to a message with an emoji - a standard one or one of a server's
 * own. Both are the same string to this file: `emoji` is either the unicode
 * character itself or `custom:<guild emoji id>`, the shape described on
 * `Reaction` in entities.ts.
 */

/**
 * Generous enough for the longest real unicode emoji - a flag or a family
 * sequence with skin-tone modifiers runs to a few dozen UTF-16 units - and
 * for `custom:` plus a snowflake, and nowhere near enough for anything else
 * somebody might try to store here instead.
 */
const MAX_EMOJI_LENGTH = 64;

/**
 * Duplicated from messages.ts rather than imported: that file already
 * imports from this one (for the reaction totals attached to a message), and
 * a function needed on both sides of that would make the two files depend on
 * each other. Four lines is cheaper than a circular import.
 */
function audienceOf(access: ChannelAccess, userId: string): Audience {
  return access.kind === 'guild'
    ? { kind: 'guild', guildId: access.guildId }
    : { kind: 'dm', userIds: [userId, access.otherId] };
}

function normaliseEmoji(raw: unknown): string {
  if (typeof raw !== 'string') throw errors.invalid('emoji is required');
  const emoji = raw.trim();
  if (emoji.length === 0 || emoji.length > MAX_EMOJI_LENGTH) {
    throw errors.invalid('That is not a usable emoji');
  }
  return emoji;
}

/** Refuses a reaction naming a custom emoji that does not exist. Unicode needs no such check. */
async function assertEmojiExists(emoji: string): Promise<void> {
  if (!emoji.startsWith('custom:')) return;
  const emojiId = emoji.slice('custom:'.length);
  const row = await db.query.guildEmoji.findFirst({ where: eq(guildEmoji.id, emojiId) });
  if (!row) throw errors.notFound('No such emoji');
}

/**
 * Every reaction on a page of messages, grouped by message and then by
 * emoji - mirrors attachments.ts's `forMessages`, including the name, so a
 * page of history costs one query instead of one per message.
 */
export async function forMessages(messageIds: string[]): Promise<Map<string, Reaction[]>> {
  const grouped = new Map<string, Reaction[]>();
  if (messageIds.length === 0) return grouped;

  const rows = await db
    .select()
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds));

  const byMessage = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const byEmoji = byMessage.get(row.messageId) ?? new Map<string, string[]>();
    const userIds = byEmoji.get(row.emoji) ?? [];
    userIds.push(row.userId);
    byEmoji.set(row.emoji, userIds);
    byMessage.set(row.messageId, byEmoji);
  }
  for (const [messageId, byEmoji] of byMessage) {
    grouped.set(
      messageId,
      [...byEmoji.entries()].map(([emoji, userIds]) => ({ emoji, userIds })),
    );
  }
  return grouped;
}

/** One message's worth of `forMessages` - empty rather than throwing when nobody has reacted. */
export async function reactionsFor(messageId: string): Promise<Reaction[]> {
  return (await forMessages([messageId])).get(messageId) ?? [];
}

async function messageAndAccess(
  messageId: string,
  userId: string,
): Promise<{ channelId: string; audience: Audience }> {
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) throw errors.notFound('No such message');

  // Reacting is a form of speaking in the channel, and reuses the same
  // permission createMessage does - no new bit for a second thing "sending"
  // already covers.
  const access = await requireChannelAccess(
    message.channelId,
    userId,
    Permission.SEND_MESSAGES,
    'You do not have permission to react in that channel',
  );
  return { channelId: message.channelId, audience: audienceOf(access, userId) };
}

export interface ReactionChange {
  channelId: string;
  audience: Audience;
  reactions: Reaction[];
}

/**
 * Adds one, unless this person already has. The primary key is the claim -
 * `onConflictDoNothing` rather than checking first - so a doubled click from
 * a slow connection lands once, not as an error.
 */
export async function addReaction(input: {
  userId: string;
  messageId: string;
  emoji: unknown;
}): Promise<ReactionChange> {
  const emoji = normaliseEmoji(input.emoji);
  const { channelId, audience } = await messageAndAccess(input.messageId, input.userId);
  await assertEmojiExists(emoji);

  await db
    .insert(messageReactions)
    .values({ messageId: input.messageId, userId: input.userId, emoji })
    .onConflictDoNothing();

  return { channelId, audience, reactions: await reactionsFor(input.messageId) };
}

/** Removing a reaction that is not there is not an error - there is simply nothing to delete. */
export async function removeReaction(input: {
  userId: string;
  messageId: string;
  emoji: unknown;
}): Promise<ReactionChange> {
  const emoji = normaliseEmoji(input.emoji);
  const { channelId, audience } = await messageAndAccess(input.messageId, input.userId);

  await db
    .delete(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, input.messageId),
        eq(messageReactions.userId, input.userId),
        eq(messageReactions.emoji, emoji),
      ),
    );

  return { channelId, audience, reactions: await reactionsFor(input.messageId) };
}
