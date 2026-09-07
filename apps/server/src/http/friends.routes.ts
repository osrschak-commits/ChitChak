import { blockUserSchema, sendFriendRequestSchema } from '@chitchak/protocol';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { channels, users } from '../db/schema.js';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
import { openDmChannel } from '../services/dms.js';
import {
  acceptRequest,
  blockUser,
  blockedIdsFor,
  relationshipBetween,
  relationshipsFor,
  removeRelationship,
  sendRequest,
  unblockUser,
} from '../services/friends.js';
import { progress } from '../services/progress.js';
import { toChannel, toPublicUser } from '../services/serialize.js';
import { authenticate, requireUser } from './authenticate.js';

/**
 * Friends, requests and blocking.
 *
 * Requests are addressed by username on the way out - that is what you know
 * before you are connected - and by user id everywhere after, because a
 * username can change and an id cannot.
 */

/** Users by id, in one query, shaped for the wire. */
async function publicUsers(ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db.query.users.findMany({ where: inArray(users.id, ids) });
  return rows.map(toPublicUser);
}

async function requirePublicUser(userId: string) {
  const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!row || row.deletedAt) throw errors.notFound('No such person');
  return toPublicUser(row);
}

export async function friendRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  /** Friends and both directions of pending request, in one call. */
  app.get('/api/friends', async (request) => {
    const { userId } = requireUser(request);
    const { friendIds, incoming, outgoing } = await relationshipsFor(userId);

    const people = await publicUsers([...friendIds, ...incoming, ...outgoing]);
    const byId = new Map(people.map((person) => [person.id, person]));

    return {
      friends: friendIds.map((id) => byId.get(id)).filter(Boolean),
      incoming: incoming.map((id) => byId.get(id)).filter(Boolean),
      outgoing: outgoing.map((id) => byId.get(id)).filter(Boolean),
    };
  });

  /**
   * Ask someone to be your friend, or accept the request they already sent.
   *
   * Rate limited hard: each call reaches a person who did not ask to hear from
   * you, and the address is one the sender chose.
   */
  app.post('/api/friends/requests', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    handler: async (request) => {
      const { userId } = requireUser(request);

      const parsed = sendFriendRequestSchema.safeParse(request.body);
      if (!parsed.success) throw errors.invalid('Enter a username');

      const outcome = await sendRequest(userId, parsed.data.username);
      const [me, them] = await Promise.all([
        requirePublicUser(userId),
        requirePublicUser(outcome.otherId),
      ]);

      if (outcome.state === 'pending') {
        registry.publishToUsers([outcome.otherId], { op: 'friend:request', d: { user: me } });
        return { state: 'pending', user: them };
      }

      // They had already asked, so this was an acceptance in disguise.
      const channel = await announceFriendship(userId, outcome.otherId, me, them);
      return { state: 'accepted', user: them, channel };
    },
  });

  app.post<{ Params: { userId: string } }>(
    '/api/friends/requests/:userId/accept',
    async (request) => {
      const { userId } = requireUser(request);
      const otherId = request.params.userId;

      await acceptRequest(userId, otherId);

      const [me, them] = await Promise.all([
        requirePublicUser(userId),
        requirePublicUser(otherId),
      ]);
      const channel = await announceFriendship(userId, otherId, me, them);
      return { user: them, channel };
    },
  );

  /**
   * Decline an incoming request, or cancel one you sent.
   *
   * The same row and the same delete - the client calls them different things
   * because they mean different things to a person, not to the database.
   */
  app.delete<{ Params: { userId: string } }>(
    '/api/friends/requests/:userId',
    async (request, reply) => {
      const { userId } = requireUser(request);
      const otherId = request.params.userId;

      const existing = await relationshipBetween(userId, otherId);
      if (!existing || existing.state !== 'pending') throw errors.notFound('No such request');

      await removeRelationship(userId, otherId);
      notifyRemoved(userId, otherId);
      return reply.code(204).send();
    },
  );

  /** Unfriend. Silent - they are not told, they simply stop appearing. */
  app.delete<{ Params: { userId: string } }>('/api/friends/:userId', async (request, reply) => {
    const { userId } = requireUser(request);
    const otherId = request.params.userId;

    const removed = await removeRelationship(userId, otherId);
    if (!removed) throw errors.notFound('You are not friends');

    notifyRemoved(userId, otherId);
    return reply.code(204).send();
  });

  /**
   * Open the conversation with a friend, creating it the first time.
   *
   * Idempotent, so the client can call it every time a DM is opened without
   * tracking whether one already exists.
   */
  app.post<{ Params: { userId: string } }>('/api/friends/:userId/dm', async (request) => {
    const { userId } = requireUser(request);
    const { channelId } = await openDmChannel(userId, request.params.userId);

    const row = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
    if (!row) throw errors.notFound('No such channel');
    return toChannel(row);
  });

  // --- Blocking --------------------------------------------------------------

  app.get('/api/blocks', async (request) => {
    const { userId } = requireUser(request);
    return publicUsers(await blockedIdsFor(userId));
  });

  app.post('/api/blocks', async (request, reply) => {
    const { userId } = requireUser(request);

    const parsed = blockUserSchema.safeParse(request.body);
    if (!parsed.success) throw errors.invalid('userId is required');

    const target = await requirePublicUser(parsed.data.userId);
    await blockUser(userId, target.id);

    // Blocking removes any friendship, so both sides need to hear about it -
    // and the blocked person is told only that the relationship ended, which is
    // all they would have learned from being unfriended.
    notifyRemoved(userId, target.id);
    return reply.code(204).send();
  });

  app.delete<{ Params: { userId: string } }>('/api/blocks/:userId', async (request, reply) => {
    const { userId } = requireUser(request);
    await unblockUser(userId, request.params.userId);
    return reply.code(204).send();
  });
}

/**
 * Tell both people they are now friends, and give them somewhere to talk.
 *
 * The DM channel is created here rather than on first message so that
 * `friend:accept` can carry it: the conversation exists the moment the
 * friendship does, and neither client has to ask for it separately.
 */
async function announceFriendship(
  userId: string,
  otherId: string,
  me: Awaited<ReturnType<typeof requirePublicUser>>,
  them: Awaited<ReturnType<typeof requirePublicUser>>,
) {
  const { channelId } = await openDmChannel(userId, otherId);
  const row = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
  if (!row) throw errors.invalid('Could not open a conversation');
  const channel = toChannel(row);

  registry.publishToUsers([userId], { op: 'friend:accept', d: { user: them, dmChannel: channel } });
  registry.publishToUsers([otherId], { op: 'friend:accept', d: { user: me, dmChannel: channel } });

  // Both of them gained a friend, so both are re-checked.
  void progress(userId, 'friend');
  void progress(otherId, 'friend');

  return channel;
}

/** One event, both directions - see the note on `friend:remove` in the protocol. */
function notifyRemoved(userId: string, otherId: string): void {
  registry.publishToUsers([userId], { op: 'friend:remove', d: { userId: otherId } });
  registry.publishToUsers([otherId], { op: 'friend:remove', d: { userId } });
}
