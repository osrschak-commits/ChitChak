import { and, eq, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { channels, dmChannels } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { areFriends, pair } from './friends.js';

/**
 * Direct messages.
 *
 * A DM is a text channel with no guild. Everything that already works on a
 * channel - posting, editing, deleting, paging back through history, typing
 * indicators - works on it unchanged, because none of that code ever asks what
 * a channel is attached to. The only places that had to learn about DMs are the
 * two that genuinely differ: who is allowed in (no ranks to resolve through),
 * and who an event is sent to (two people, not a guild).
 *
 * DMs are between friends only. That is what keeps blocking meaningful -
 * blocking removes the friendship, so it removes the ability to write - and it
 * means an open sign-up page never turns into an inbox strangers can reach.
 */

/**
 * The name stored on a DM channel's row.
 *
 * Never displayed: a DM is shown as the other person, whose name can change
 * and belongs to them, not to the channel. `channels.name` is NOT NULL, so
 * something has to sit here.
 */
const DM_CHANNEL_NAME = 'dm';

export interface DmChannel {
  channelId: string;
  otherId: string;
}

/**
 * The conversation between two friends, creating it the first time.
 *
 * Get-or-create rather than an explicit "start a conversation" step: opening a
 * DM is the only way one comes into existence, and asking someone to press
 * "create" first would be a step with no decision in it.
 */
export async function openDmChannel(userId: string, otherId: string): Promise<DmChannel> {
  if (userId === otherId) throw errors.invalid('You cannot message yourself');

  if (!(await areFriends(userId, otherId))) {
    // Covers "never were friends", "unfriended" and "blocked" alike - blocking
    // deletes the friendship, so this one check closes all three.
    throw errors.forbidden('You can only message friends');
  }

  const { userA, userB } = pair(userId, otherId);

  const existing = await db.query.dmChannels.findFirst({
    where: and(eq(dmChannels.userA, userA), eq(dmChannels.userB, userB)),
  });
  if (existing) return { channelId: existing.channelId, otherId };

  const channelId = generateId();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(channels).values({
        id: channelId,
        guildId: null,
        name: DM_CHANNEL_NAME,
        kind: 'text',
      });
      await tx.insert(dmChannels).values({ userA, userB, channelId });
    });
    return { channelId, otherId };
  } catch (error) {
    // The pair is the primary key, so a collision means the other person opened
    // the same conversation in the moment between the read above and this
    // insert. Theirs is as good as ours; use it. Without the unique key this
    // would instead be two channels for one conversation, each holding half the
    // messages, and nobody would notice until someone asked where a message went.
    if (!isUniqueViolation(error)) throw error;

    const raced = await db.query.dmChannels.findFirst({
      where: and(eq(dmChannels.userA, userA), eq(dmChannels.userB, userB)),
    });
    if (!raced) throw error;
    return { channelId: raced.channelId, otherId };
  }
}

/** Every conversation this user is part of, for the ready snapshot. */
export async function dmChannelsFor(userId: string): Promise<DmChannel[]> {
  const rows = await db
    .select()
    .from(dmChannels)
    .where(or(eq(dmChannels.userA, userId), eq(dmChannels.userB, userId)));

  return rows.map((row) => ({
    channelId: row.channelId,
    otherId: row.userA === userId ? row.userB : row.userA,
  }));
}

/** The two people in a DM channel, or null if it is not one. */
export async function dmParticipants(channelId: string): Promise<[string, string] | null> {
  const row = await db.query.dmChannels.findFirst({
    where: eq(dmChannels.channelId, channelId),
  });
  return row ? [row.userA, row.userB] : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}
