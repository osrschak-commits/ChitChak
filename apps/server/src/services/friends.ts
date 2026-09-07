import { and, eq, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { blocks, friendships, users } from '../db/schema.js';
import { errors } from '../lib/errors.js';

/**
 * Friendship, blocking, and the one invariant everything here rests on.
 *
 * A pair is always stored with the lower id first. Every read and write goes
 * through `pair()` so that the ordering is decided in exactly one place - the
 * moment two call sites disagree about which way round to store it, the
 * primary key stops protecting anything and duplicate friendships become
 * possible again.
 */

/** The canonical, sorted form of a pair of user ids. */
export function pair(one: string, two: string): { userA: string; userB: string } {
  return one < two ? { userA: one, userB: two } : { userA: two, userB: one };
}

/** Matches the single row for this pair, whichever way round it was asked for. */
function pairIs(one: string, two: string) {
  const { userA, userB } = pair(one, two);
  return and(eq(friendships.userA, userA), eq(friendships.userB, userB));
}

export interface Relationship {
  userA: string;
  userB: string;
  state: 'pending' | 'accepted';
  requestedBy: string;
}

export async function relationshipBetween(
  one: string,
  two: string,
): Promise<Relationship | null> {
  const row = await db.query.friendships.findFirst({ where: pairIs(one, two) });
  return row ?? null;
}

/** Ids of everyone `userId` is actually friends with. */
export async function friendIdsFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({ userA: friendships.userA, userB: friendships.userB })
    .from(friendships)
    .where(
      and(
        eq(friendships.state, 'accepted'),
        or(eq(friendships.userA, userId), eq(friendships.userB, userId)),
      ),
    );

  return rows.map((row) => (row.userA === userId ? row.userB : row.userA));
}

export async function areFriends(one: string, two: string): Promise<boolean> {
  const row = await relationshipBetween(one, two);
  return row?.state === 'accepted';
}

/**
 * Whether either of them has blocked the other.
 *
 * Deliberately direction-blind at the call sites that gate contact: for
 * deciding whether two people may reach each other, who did the blocking does
 * not matter. `blockDirection` is there for the places that need to explain
 * themselves to one of the two.
 */
export async function blockExistsBetween(one: string, two: string): Promise<boolean> {
  const row = await db.query.blocks.findFirst({
    where: or(
      and(eq(blocks.blockerId, one), eq(blocks.blockedId, two)),
      and(eq(blocks.blockerId, two), eq(blocks.blockedId, one)),
    ),
  });
  return Boolean(row);
}

export async function hasBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  const row = await db.query.blocks.findFirst({
    where: and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)),
  });
  return Boolean(row);
}

/** Resolves a username the way the add-a-friend field means it: exactly. */
export async function findByUsername(username: string): Promise<typeof users.$inferSelect> {
  const normalised = username.trim().toLowerCase();
  const user = await db.query.users.findFirst({ where: eq(users.username, normalised) });

  // A deleted account is not "found and unavailable", it is not found - saying
  // otherwise confirms that the name was once real and who it belonged to.
  if (!user || user.deletedAt) throw errors.notFound('No one with that username');
  return user;
}

export type SendOutcome = { state: 'pending' | 'accepted'; otherId: string };

/**
 * Send a friend request, or accept the one already waiting.
 *
 * The mutual case is not an error and not a special path the caller has to ask
 * for: if they had already asked you, asking them back is consent, and the
 * result is a friendship. That is also how the simultaneous case resolves - see
 * the unique-violation retry below.
 */
export async function sendRequest(fromId: string, username: string): Promise<SendOutcome> {
  const target = await findByUsername(username);

  if (target.id === fromId) throw errors.invalid('You cannot add yourself');

  if (await hasBlocked(fromId, target.id)) {
    throw errors.forbidden('You have blocked them. Unblock them first.');
  }
  if (await hasBlocked(target.id, fromId)) {
    // Deliberately vague. "They have blocked you" is a fact about someone else
    // that they chose not to share.
    throw errors.forbidden('Could not send a request to that person');
  }

  const existing = await relationshipBetween(fromId, target.id);

  if (existing?.state === 'accepted') {
    throw errors.conflict('You are already friends');
  }
  if (existing?.state === 'pending') {
    if (existing.requestedBy === fromId) throw errors.conflict('You have already asked them');
    await acceptRequest(fromId, target.id);
    return { state: 'accepted', otherId: target.id };
  }

  const { userA, userB } = pair(fromId, target.id);

  try {
    await db.insert(friendships).values({
      userA,
      userB,
      state: 'pending',
      requestedBy: fromId,
    });
    return { state: 'pending', otherId: target.id };
  } catch (error) {
    // The pair is the primary key, so the only way this insert collides is that
    // the other person inserted the mirror of it between the read above and
    // here - which means they asked at the same moment we did. Both wanted it;
    // accept.
    if (!isUniqueViolation(error)) throw error;

    const now = await relationshipBetween(fromId, target.id);
    if (now?.state === 'pending' && now.requestedBy !== fromId) {
      await acceptRequest(fromId, target.id);
      return { state: 'accepted', otherId: target.id };
    }
    if (now?.state === 'accepted') return { state: 'accepted', otherId: target.id };
    throw errors.conflict('You have already asked them');
  }
}

/** @throws unless there is a pending request from `otherId` to `userId`. */
export async function acceptRequest(userId: string, otherId: string): Promise<void> {
  const existing = await relationshipBetween(userId, otherId);
  if (!existing || existing.state !== 'pending') throw errors.notFound('No request from them');
  if (existing.requestedBy === userId) throw errors.invalid('You sent that request');

  await db
    .update(friendships)
    .set({ state: 'accepted', respondedAt: new Date() })
    .where(pairIs(userId, otherId));
}

/**
 * Removes the relationship, whatever it currently is.
 *
 * Unfriending, declining and cancelling are the same row and the same delete.
 * The client calls them different things because they mean different things to
 * a person; the database has no reason to.
 *
 * @returns whether anything was actually there.
 */
export async function removeRelationship(userId: string, otherId: string): Promise<boolean> {
  const existing = await relationshipBetween(userId, otherId);
  if (!existing) return false;
  await db.delete(friendships).where(pairIs(userId, otherId));
  return true;
}

/**
 * Block someone, ending any relationship with them in the same breath.
 *
 * One transaction, because a block that leaves a friendship behind is worse
 * than no block at all.
 */
export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  if (blockerId === blockedId) throw errors.invalid('You cannot block yourself');

  const { userA, userB } = pair(blockerId, blockedId);

  await db.transaction(async (tx) => {
    await tx
      .delete(friendships)
      .where(and(eq(friendships.userA, userA), eq(friendships.userB, userB)));
    await tx
      .insert(blocks)
      .values({ blockerId, blockedId })
      // Blocking someone already blocked is not an error, it is a no-op.
      .onConflictDoNothing();
  });
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await db
    .delete(blocks)
    .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)));
}

/** Everyone this user has blocked. */
export async function blockedIdsFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({ blockedId: blocks.blockedId })
    .from(blocks)
    .where(eq(blocks.blockerId, userId));
  return rows.map((row) => row.blockedId);
}

/**
 * The whole relationship picture for one person, in one round trip.
 *
 * Split into the three lists the client actually renders rather than handing
 * over rows and making it work out which side of each it is on.
 */
export async function relationshipsFor(userId: string): Promise<{
  friendIds: string[];
  incoming: string[];
  outgoing: string[];
}> {
  const rows = await db
    .select()
    .from(friendships)
    .where(or(eq(friendships.userA, userId), eq(friendships.userB, userId)));

  const friendIds: string[] = [];
  const incoming: string[] = [];
  const outgoing: string[] = [];

  for (const row of rows) {
    const otherId = row.userA === userId ? row.userB : row.userA;
    if (row.state === 'accepted') friendIds.push(otherId);
    else if (row.requestedBy === userId) outgoing.push(otherId);
    else incoming.push(otherId);
  }

  return { friendIds, incoming, outgoing };
}

/** Postgres unique-violation, which `postgres` surfaces as a code on the error. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}
