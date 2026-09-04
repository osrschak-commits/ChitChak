import {
  ALL_PERMISSIONS,
  Permission,
  createRankSchema,
  reorderRanksSchema,
  setMemberRanksSchema,
  setOverwriteSchema,
  updateNicknameSchema,
  updateRankSchema,
} from '@chitchak/protocol';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { channelOverwrites, channels, guildMembers, memberRanks, ranks } from '../db/schema.js';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import {
  memberContext,
  requirePermission,
  requireRankBelow,
} from '../services/permissions.js';
import { buildMember } from '../services/snapshot.js';
import { compareRanks, toOverwrite, toRank } from '../services/serialize.js';
import { authenticate, requireUser } from './authenticate.js';

/**
 * Ranks, rank assignment, and per-channel overwrites.
 *
 * Two rules run through all of it:
 *
 *   - You cannot manage a rank at or above your own highest. Otherwise anyone
 *     with MANAGE_RANKS could promote themselves to the top.
 *   - You cannot grant a permission you do not hold. Otherwise MANAGE_RANKS is
 *     a backdoor to ADMINISTRATOR.
 */
export async function rankRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/ranks', async (request) => {
    const { userId } = requireUser(request);
    await memberContext(request.params.guildId, userId);

    const rows = await db
      .select()
      .from(ranks)
      .where(eq(ranks.guildId, request.params.guildId))
      .orderBy(desc(ranks.position));
    return rows.map(toRank).sort(compareRanks);
  });

  app.post<{ Params: { guildId: string } }>('/api/guilds/:guildId/ranks', async (request, reply) => {
    const { userId } = requireUser(request);
    const actor = await requirePermission(
      request.params.guildId,
      userId,
      Permission.MANAGE_RANKS,
      'You need the Manage ranks permission',
    );

    const parsed = createRankSchema.safeParse(request.body);
    if (!parsed.success) {
      throw errors.invalid(parsed.error.issues[0]?.message ?? 'Invalid rank');
    }

    const requested = parsed.data.permissions ?? 0;
    assertCanGrant(actor.permissions, requested);

    // New ranks slot in directly below the creator, which is the only position
    // that is always legal for them to manage.
    const [highest] = await db
      .select({ max: sql<number>`coalesce(max(${ranks.position}), 0)` })
      .from(ranks)
      .where(eq(ranks.guildId, request.params.guildId));

    const ceiling = actor.isOwner ? (highest?.max ?? 0) + 1 : actor.position - 1;
    const position = Math.max(1, Math.min(ceiling, (highest?.max ?? 0) + 1));

    const [row] = await db
      .insert(ranks)
      .values({
        id: generateId(),
        guildId: request.params.guildId,
        name: parsed.data.name.trim(),
        color: parsed.data.color ?? null,
        permissions: requested,
        position,
        isDefault: false,
      })
      .returning();
    if (!row) throw errors.invalid('Could not create that rank');

    const rank = toRank(row);
    registry.publishToGuild(rank.guildId, { op: 'rank:create', d: rank });
    return reply.code(201).send(rank);
  });

  app.patch<{ Params: { rankId: string } }>('/api/ranks/:rankId', async (request) => {
    const { userId } = requireUser(request);
    const existing = await db.query.ranks.findFirst({ where: eq(ranks.id, request.params.rankId) });
    if (!existing) throw errors.notFound('No such rank');

    const actor = await requirePermission(existing.guildId, userId, Permission.MANAGE_RANKS);
    await requireRankBelow(actor, existing.position);

    const parsed = updateRankSchema.safeParse(request.body);
    if (!parsed.success) {
      throw errors.invalid(parsed.error.issues[0]?.message ?? 'Invalid rank');
    }

    const update: Partial<typeof ranks.$inferInsert> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.color !== undefined) update.color = parsed.data.color;
    if (parsed.data.permissions !== undefined) {
      // Only the bits actually changing need to be grantable: leaving an
      // existing permission alone is not the same as granting it.
      const changed = parsed.data.permissions ^ existing.permissions;
      assertCanGrant(actor.permissions, changed);
      update.permissions = parsed.data.permissions;
    }

    if (Object.keys(update).length === 0) return toRank(existing);

    const [row] = await db
      .update(ranks)
      .set(update)
      .where(eq(ranks.id, request.params.rankId))
      .returning();
    if (!row) throw errors.notFound('No such rank');

    const rank = toRank(row);
    registry.publishToGuild(rank.guildId, { op: 'rank:update', d: rank });
    return rank;
  });

  app.delete<{ Params: { rankId: string } }>('/api/ranks/:rankId', async (request, reply) => {
    const { userId } = requireUser(request);
    const existing = await db.query.ranks.findFirst({ where: eq(ranks.id, request.params.rankId) });
    if (!existing) throw errors.notFound('No such rank');
    if (existing.isDefault) throw errors.invalid('The default rank cannot be deleted');

    const actor = await requirePermission(existing.guildId, userId, Permission.MANAGE_RANKS);
    await requireRankBelow(actor, existing.position);

    await db.delete(ranks).where(eq(ranks.id, request.params.rankId));

    registry.publishToGuild(existing.guildId, {
      op: 'rank:delete',
      d: { guildId: existing.guildId, rankId: existing.id },
    });
    return reply.code(204).send();
  });

  app.patch<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/ranks/order',
    async (request) => {
      const { userId } = requireUser(request);
      const actor = await requirePermission(request.params.guildId, userId, Permission.MANAGE_RANKS);

      const parsed = reorderRanksSchema.safeParse(request.body);
      if (!parsed.success) throw errors.invalid('Send { order: [rankId, ...] } , most senior first');

      const guildRanks = await db
        .select()
        .from(ranks)
        .where(eq(ranks.guildId, request.params.guildId));
      const byId = new Map(guildRanks.map((r) => [r.id, r]));

      // The default rank is always the floor; it cannot be reordered above
      // anything, because every member holds it.
      const ordered = parsed.data.order.filter((id) => byId.get(id)?.isDefault === false);

      for (const rankId of ordered) {
        const rank = byId.get(rankId);
        if (rank) await requireRankBelow(actor, rank.position);
      }

      // Positions count down from the top so that 1 is the lowest non-default.
      await db.transaction(async (tx) => {
        let position = ordered.length;
        for (const rankId of ordered) {
          await tx.update(ranks).set({ position }).where(eq(ranks.id, rankId));
          position -= 1;
        }
        await tx
          .update(ranks)
          .set({ position: 0 })
          .where(and(eq(ranks.guildId, request.params.guildId), eq(ranks.isDefault, true)));
      });

      const updated = await db
        .select()
        .from(ranks)
        .where(eq(ranks.guildId, request.params.guildId))
        .orderBy(desc(ranks.position));

      const payload = updated.map(toRank);
      for (const rank of payload) {
        registry.publishToGuild(rank.guildId, { op: 'rank:update', d: rank });
      }
      return payload.sort(compareRanks);
    },
  );

  // --- Assignment ----------------------------------------------------------

  app.put<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/members/:userId/ranks',
    async (request) => {
      const { userId: actorId } = requireUser(request);
      const actor = await requirePermission(
        request.params.guildId,
        actorId,
        Permission.MANAGE_RANKS,
      );

      const parsed = setMemberRanksSchema.safeParse(request.body);
      if (!parsed.success) throw errors.invalid('Send { rankIds: [...] }');

      const target = await db.query.guildMembers.findFirst({
        where: and(
          eq(guildMembers.guildId, request.params.guildId),
          eq(guildMembers.userId, request.params.userId),
        ),
      });
      if (!target) throw errors.notFound('That person is not in this server');

      const requested = parsed.data.rankIds.length
        ? await db
            .select()
            .from(ranks)
            .where(
              and(
                eq(ranks.guildId, request.params.guildId),
                inArray(ranks.id, parsed.data.rankIds),
              ),
            )
        : [];

      for (const rank of requested) {
        if (rank.isDefault) throw errors.invalid('The default rank is held by everyone already');
        await requireRankBelow(actor, rank.position);
      }

      // Ranks the actor cannot manage must survive the write, or editing
      // someone's ranks would silently strip the ones above the actor.
      const current = await db
        .select({ rank: ranks })
        .from(memberRanks)
        .innerJoin(ranks, eq(ranks.id, memberRanks.rankId))
        .where(
          and(
            eq(memberRanks.guildId, request.params.guildId),
            eq(memberRanks.userId, request.params.userId),
          ),
        );
      const untouchable = current
        .filter((c) => !actor.isOwner && c.rank.position >= actor.position)
        .map((c) => c.rank.id);

      const finalIds = [...new Set([...requested.map((r) => r.id), ...untouchable])];

      await db.transaction(async (tx) => {
        await tx
          .delete(memberRanks)
          .where(
            and(
              eq(memberRanks.guildId, request.params.guildId),
              eq(memberRanks.userId, request.params.userId),
            ),
          );
        if (finalIds.length > 0) {
          await tx.insert(memberRanks).values(
            finalIds.map((rankId) => ({
              guildId: request.params.guildId,
              userId: request.params.userId,
              rankId,
            })),
          );
        }
      });

      const member = await buildMember(request.params.guildId, request.params.userId);
      if (member) {
        registry.publishToGuild(request.params.guildId, { op: 'guild:member_update', d: member });
      }
      return member;
    },
  );

  app.patch<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/members/:userId/nickname',
    async (request) => {
      const { userId: actorId } = requireUser(request);
      const actor = await memberContext(request.params.guildId, actorId);

      // Changing your own nickname needs nothing; changing someone else's is a
      // moderation action.
      if (actorId !== request.params.userId) {
        await requirePermission(request.params.guildId, actorId, Permission.KICK_MEMBERS);
        const target = await memberContext(request.params.guildId, request.params.userId);
        if (!actor.isOwner && target.position >= actor.position) {
          throw errors.forbidden('You cannot rename someone at or above your own rank');
        }
      }

      const parsed = updateNicknameSchema.safeParse(request.body);
      if (!parsed.success) throw errors.invalid('Nicknames must be 48 characters or fewer');

      await db
        .update(guildMembers)
        .set({ nickname: parsed.data.nickname?.trim() || null })
        .where(
          and(
            eq(guildMembers.guildId, request.params.guildId),
            eq(guildMembers.userId, request.params.userId),
          ),
        );

      const member = await buildMember(request.params.guildId, request.params.userId);
      if (member) {
        registry.publishToGuild(request.params.guildId, { op: 'guild:member_update', d: member });
      }
      return member;
    },
  );

  // --- Channel overwrites --------------------------------------------------

  app.put<{ Params: { channelId: string } }>(
    '/api/channels/:channelId/overwrites',
    async (request) => {
      const { userId } = requireUser(request);
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, request.params.channelId),
      });
      if (!channel) throw errors.notFound('No such channel');

      const actor = await requirePermission(channel.guildId, userId, Permission.MANAGE_CHANNELS);

      const parsed = setOverwriteSchema.safeParse(request.body);
      if (!parsed.success) {
        throw errors.invalid(parsed.error.issues[0]?.message ?? 'Invalid overwrite');
      }

      const rank = await db.query.ranks.findFirst({ where: eq(ranks.id, parsed.data.rankId) });
      if (!rank || rank.guildId !== channel.guildId) throw errors.notFound('No such rank');

      // Overwrites can hand out permissions, so the same rule applies as when
      // editing a rank: you cannot grant what you do not hold.
      assertCanGrant(actor.permissions, parsed.data.allow);
      if (!rank.isDefault) await requireRankBelow(actor, rank.position);

      if (parsed.data.allow === 0 && parsed.data.deny === 0) {
        await db
          .delete(channelOverwrites)
          .where(
            and(
              eq(channelOverwrites.channelId, channel.id),
              eq(channelOverwrites.rankId, rank.id),
            ),
          );
      } else {
        await db
          .insert(channelOverwrites)
          .values({
            channelId: channel.id,
            rankId: rank.id,
            allow: parsed.data.allow,
            deny: parsed.data.deny,
          })
          .onConflictDoUpdate({
            target: [channelOverwrites.channelId, channelOverwrites.rankId],
            set: { allow: parsed.data.allow, deny: parsed.data.deny },
          });
      }

      const rows = await db
        .select()
        .from(channelOverwrites)
        .where(eq(channelOverwrites.channelId, channel.id));
      const overwrites = rows.map(toOverwrite);

      // Broadcast to the guild: someone who just lost VIEW_CHANNEL needs to
      // stop seeing it, and someone who just gained it needs to start.
      registry.publishToGuild(channel.guildId, {
        op: 'channel:overwrites',
        d: { channelId: channel.id, overwrites },
      });
      return overwrites;
    },
  );

  app.get<{ Params: { channelId: string } }>(
    '/api/channels/:channelId/overwrites',
    async (request) => {
      const { userId } = requireUser(request);
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, request.params.channelId),
      });
      if (!channel) throw errors.notFound('No such channel');
      await requirePermission(channel.guildId, userId, Permission.MANAGE_CHANNELS);

      const rows = await db
        .select()
        .from(channelOverwrites)
        .where(eq(channelOverwrites.channelId, channel.id))
        .orderBy(asc(channelOverwrites.rankId));
      return rows.map(toOverwrite);
    },
  );
}

/**
 * You cannot grant a permission you do not hold.
 *
 * Without this, MANAGE_RANKS is equivalent to ADMINISTRATOR: make a rank with
 * every permission, assign it to yourself, done.
 */
function assertCanGrant(actorPermissions: number, requested: number): void {
  if ((actorPermissions & Permission.ADMINISTRATOR) !== 0) return;
  const excess = requested & ~actorPermissions & ALL_PERMISSIONS;
  if (excess !== 0) {
    throw errors.forbidden('You cannot grant permissions you do not have yourself');
  }
}
