import { randomInt } from 'node:crypto';
import type { CreateGuildResponse } from '@chitchak/protocol';
import {
  DEFAULT_RANK_PERMISSIONS,
  Permission,
  createChannelSchema,
  createGuildSchema,
  createInviteSchema,
  editMessageSchema,
  imageUploadSchema,
  joinByInviteSchema,
  updateChannelSchema,
  updateGuildSchema,
} from '@chitchak/protocol';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import {
  bans,
  channels,
  guildMembers,
  guilds,
  images,
  invites,
  ranks,
  users,
  voiceStates,
} from '../db/schema.js';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { decodeDataUrl } from '../lib/images.js';
import {
  memberContext,
  requireChannelPermission,
  requirePermission,
} from '../services/permissions.js';
import {
  compareChannels,
  toChannel,
  toGuild,
  toInvite,
  toPublicUser,
} from '../services/serialize.js';
import { deleteMessage, editMessage, listMessages } from '../services/messages.js';
import { buildMember } from '../services/snapshot.js';
import { deleteRoom } from '../voice/livekit.js';
import { authenticate, requireUser } from './authenticate.js';

/** Unambiguous alphabet: no 0/O, 1/I/l - invite codes get read aloud and retyped. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateInviteCode(length = 8): string {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

/** Deleting a server is owner-only: no permission short of ownership grants it. */
async function assertOwner(guildId: string, userId: string): Promise<typeof guilds.$inferSelect> {
  const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, guildId) });
  if (!guild) throw errors.notFound('No such server');
  if (guild.ownerId !== userId) throw errors.forbidden('Only the server owner can do that');
  return guild;
}

export async function guildRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/api/guilds', async (request) => {
    const { userId } = requireUser(request);
    // Ordered by join time: without an ORDER BY, Postgres is free to return
    // rows in whatever order it likes, which makes the server switcher shuffle
    // itself between fetches.
    const rows = await db
      .select({ guild: guilds })
      .from(guildMembers)
      .innerJoin(guilds, eq(guilds.id, guildMembers.guildId))
      .where(eq(guildMembers.userId, userId))
      .orderBy(asc(guildMembers.joinedAt), asc(guilds.id));
    return rows.map((r) => toGuild(r.guild));
  });

  app.post('/api/guilds', async (request, reply) => {
    const { userId } = requireUser(request);
    const parsed = createGuildSchema.safeParse(request.body);
    if (!parsed.success) throw errors.invalid('Server name must be 2-64 characters');

    // One transaction: a guild with no owner-membership or no channels would be
    // a server nobody can enter or use.
    const result = await db.transaction(async (tx): Promise<CreateGuildResponse> => {
      const guildId = generateId();
      const [guild] = await tx
        .insert(guilds)
        .values({ id: guildId, name: parsed.data.name.trim(), ownerId: userId })
        .returning();
      if (!guild) throw errors.invalid('Could not create server');

      await tx.insert(guildMembers).values({ guildId, userId });

      // Every guild needs a default rank from the moment it exists: it is what
      // ordinary members' permissions resolve from, and a guild without one
      // would leave everyone but the owner with nothing.
      await tx.insert(ranks).values({
        id: generateId(),
        guildId,
        name: 'Member',
        color: null,
        position: 0,
        permissions: DEFAULT_RANK_PERMISSIONS,
        isDefault: true,
      });

      const created = await tx
        .insert(channels)
        .values([
          { id: generateId(), guildId, name: 'general', kind: 'text', position: 0 },
          { id: generateId(), guildId, name: 'Lounge', kind: 'voice', position: 1 },
        ])
        .returning();

      return { guild: toGuild(guild), channels: created.map(toChannel) };
    });

    return reply.code(201).send(result);
  });

  // --- Server settings -----------------------------------------------------

  app.patch<{ Params: { guildId: string } }>('/api/guilds/:guildId', async (request) => {
    const { userId } = requireUser(request);
    await requirePermission(request.params.guildId, userId, Permission.MANAGE_SERVER);

    const parsed = updateGuildSchema.safeParse(request.body);
    if (!parsed.success) {
      throw errors.invalid(parsed.error.issues[0]?.message ?? 'Invalid server settings');
    }
    if (parsed.data.name === undefined) {
      const current = await db.query.guilds.findFirst({ where: eq(guilds.id, request.params.guildId) });
      return toGuild(current!);
    }

    const [updated] = await db
      .update(guilds)
      .set({ name: parsed.data.name.trim() })
      .where(eq(guilds.id, request.params.guildId))
      .returning();
    if (!updated) throw errors.notFound('No such server');

    const guild = toGuild(updated);
    registry.publishToGuild(guild.id, { op: 'guild:update', d: guild });
    return guild;
  });

  app.put<{ Params: { guildId: string } }>('/api/guilds/:guildId/icon', async (request) => {
    const { userId } = requireUser(request);
    await requirePermission(request.params.guildId, userId, Permission.MANAGE_SERVER);

    const parsed = imageUploadSchema.safeParse(request.body);
    if (!parsed.success) {
      throw errors.invalid(parsed.error.issues[0]?.message ?? 'That image could not be read');
    }
    const image = decodeDataUrl(parsed.data.dataUrl);

    await db
      .insert(images)
      .values({
        kind: 'guild_icon',
        ownerId: request.params.guildId,
        mimeType: image.mimeType,
        data: image.bytes,
      })
      .onConflictDoUpdate({
        target: [images.kind, images.ownerId],
        set: { mimeType: image.mimeType, data: image.bytes, updatedAt: new Date() },
      });

    const [updated] = await db
      .update(guilds)
      .set({ iconVersion: sql`${guilds.iconVersion} + 1` })
      .where(eq(guilds.id, request.params.guildId))
      .returning();
    if (!updated) throw errors.notFound('No such server');

    const guild = toGuild(updated);
    registry.publishToGuild(guild.id, { op: 'guild:update', d: guild });
    return guild;
  });

  // Serving the icon image itself lives in images.routes.ts: this plugin has a
  // blanket `authenticate` hook, and an <img src> cannot send a bearer token.

  app.delete<{ Params: { guildId: string } }>('/api/guilds/:guildId', async (request, reply) => {
    const { userId } = requireUser(request);
    // Owner-only, deliberately. Deleting the server is not something any
    // permission should grant - not even ADMINISTRATOR.
    await assertOwner(request.params.guildId, userId);

    // Tear down live SFU rooms before the channel rows cascade away, otherwise
    // the SFU keeps rooms alive for channels that no longer exist.
    const voiceChannels = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.guildId, request.params.guildId), eq(channels.kind, 'voice')));
    await Promise.allSettled(voiceChannels.map((c) => deleteRoom(c.id)));

    // Announce before deleting: afterwards there is no membership left to
    // route the event to.
    registry.publishToGuild(request.params.guildId, {
      op: 'guild:delete',
      d: { guildId: request.params.guildId },
    });

    await db.delete(images).where(and(eq(images.kind, 'guild_icon'), eq(images.ownerId, request.params.guildId)));
    await db.delete(guilds).where(eq(guilds.id, request.params.guildId));

    return reply.code(204).send();
  });

  // --- Members -------------------------------------------------------------

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/members', async (request) => {
    const { userId } = requireUser(request);
    await memberContext(request.params.guildId, userId);

    const rows = await db
      .select({ member: guildMembers, user: users })
      .from(guildMembers)
      .innerJoin(users, eq(users.id, guildMembers.userId))
      .where(eq(guildMembers.guildId, request.params.guildId));

    // Rank ids come from buildMember so this endpoint and the gateway agree on
    // the shape of a member.
    return Promise.all(
      rows.map((r) => buildMember(request.params.guildId, r.member.userId)),
    ).then((members) => members.filter(Boolean));
  });

  // Kick and ban live in moderation.routes.ts, alongside the hierarchy checks.

  // --- Channels ------------------------------------------------------------

  app.post<{ Params: { guildId: string } }>('/api/guilds/:guildId/channels', async (request, reply) => {
    const { userId } = requireUser(request);
    await requirePermission(request.params.guildId, userId, Permission.MANAGE_CHANNELS);

    const parsed = createChannelSchema.safeParse(request.body);
    if (!parsed.success) {
      throw errors.invalid(parsed.error.issues[0]?.message ?? 'Invalid channel');
    }

    const [{ next } = { next: 0 }] = await db
      .select({ next: sql<number>`coalesce(max(${channels.position}), -1) + 1` })
      .from(channels)
      .where(eq(channels.guildId, request.params.guildId));

    const [row] = await db
      .insert(channels)
      .values({
        id: generateId(),
        guildId: request.params.guildId,
        name: parsed.data.name.trim(),
        kind: parsed.data.kind,
        topic: parsed.data.topic?.trim() || null,
        position: Number(next),
        userLimit: parsed.data.kind === 'voice' ? (parsed.data.userLimit ?? 0) : 0,
      })
      .returning();
    if (!row) throw errors.invalid('Could not create channel');

    const channel = toChannel(row);
    registry.publishToGuild(channel.guildId, { op: 'channel:create', d: channel });
    return reply.code(201).send(channel);
  });

  app.patch<{ Params: { channelId: string } }>('/api/channels/:channelId', async (request) => {
    const { userId } = requireUser(request);
    const existing = await db.query.channels.findFirst({
      where: eq(channels.id, request.params.channelId),
    });
    if (!existing) throw errors.notFound('No such channel');
    await assertOwner(existing.guildId, userId);

    const parsed = updateChannelSchema.safeParse(request.body);
    if (!parsed.success) {
      throw errors.invalid(parsed.error.issues[0]?.message ?? 'Invalid channel settings');
    }

    const update: Partial<typeof channels.$inferInsert> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.topic !== undefined) update.topic = parsed.data.topic?.trim() || null;
    if (parsed.data.position !== undefined) update.position = parsed.data.position;
    // A user limit on a text channel is meaningless; ignore rather than error,
    // so a form that always sends every field still works.
    if (parsed.data.userLimit !== undefined && existing.kind === 'voice') {
      update.userLimit = parsed.data.userLimit;
    }

    if (Object.keys(update).length === 0) return toChannel(existing);

    const [row] = await db
      .update(channels)
      .set(update)
      .where(eq(channels.id, request.params.channelId))
      .returning();
    if (!row) throw errors.notFound('No such channel');

    const channel = toChannel(row);
    registry.publishToGuild(channel.guildId, { op: 'channel:update', d: channel });
    return channel;
  });

  app.delete<{ Params: { channelId: string } }>('/api/channels/:channelId', async (request, reply) => {
    const { userId } = requireUser(request);
    const channel = await db.query.channels.findFirst({
      where: eq(channels.id, request.params.channelId),
    });
    if (!channel) throw errors.notFound('No such channel');
    await requirePermission(channel.guildId, userId, Permission.MANAGE_CHANNELS);

    const remaining = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.guildId, channel.guildId), eq(channels.kind, channel.kind)))
      .orderBy(asc(channels.position));
    if (remaining.length <= 1) {
      throw errors.invalid(`A server needs at least one ${channel.kind} channel`);
    }

    await db.delete(channels).where(eq(channels.id, channel.id));
    // Voice states cascade away with the channel row, but the SFU holds its own
    // state and would happily keep a live room for a channel that no longer
    // exists, so tear it down explicitly.
    if (channel.kind === 'voice') await deleteRoom(channel.id).catch(() => {});

    registry.publishToGuild(channel.guildId, {
      op: 'channel:delete',
      d: { guildId: channel.guildId, channelId: channel.id },
    });
    return reply.code(204).send();
  });

  /** Bulk reorder, so dragging a list writes one request rather than N. */
  app.patch<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/channels/order',
    async (request, reply) => {
      const { userId } = requireUser(request);
      await requirePermission(request.params.guildId, userId, Permission.MANAGE_CHANNELS);

      const body = request.body as { order?: unknown };
      if (!Array.isArray(body.order) || body.order.some((id) => typeof id !== 'string')) {
        throw errors.invalid('Send { order: [channelId, ...] }');
      }

      const owned = await db
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.guildId, request.params.guildId));
      const ownedIds = new Set(owned.map((c) => c.id));
      const order = (body.order as string[]).filter((id) => ownedIds.has(id));

      await db.transaction(async (tx) => {
        for (const [index, channelId] of order.entries()) {
          await tx.update(channels).set({ position: index }).where(eq(channels.id, channelId));
        }
      });

      const updated = await db
        .select()
        .from(channels)
        .where(eq(channels.guildId, request.params.guildId));
      const payload = updated.map(toChannel).sort(compareChannels);
      for (const channel of payload) {
        registry.publishToGuild(channel.guildId, { op: 'channel:update', d: channel });
      }

      return reply.send(payload);
    },
  );

  app.get<{ Params: { channelId: string }; Querystring: { before?: string; limit?: string } }>(
    '/api/channels/:channelId/messages',
    async (request) => {
      const { userId } = requireUser(request);
      return listMessages({
        userId,
        channelId: request.params.channelId,
        before: request.query.before,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      });
    },
  );

  // --- Messages ------------------------------------------------------------

  app.patch<{ Params: { messageId: string } }>('/api/messages/:messageId', async (request) => {
    const { userId } = requireUser(request);
    const parsed = editMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      throw errors.invalid(parsed.error.issues[0]?.message ?? 'Invalid message');
    }

    const { message, guildId } = await editMessage({
      userId,
      messageId: request.params.messageId,
      content: parsed.data.content,
    });
    registry.publishToGuild(guildId, { op: 'message:update', d: message });
    return message;
  });

  app.delete<{ Params: { messageId: string } }>(
    '/api/messages/:messageId',
    async (request, reply) => {
      const { userId } = requireUser(request);
      const { channelId, messageId, guildId } = await deleteMessage({
        userId,
        messageId: request.params.messageId,
      });
      registry.publishToGuild(guildId, { op: 'message:delete', d: { channelId, messageId } });
      return reply.code(204).send();
    },
  );

  // --- Invites -------------------------------------------------------------

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/invites', async (request) => {
    const { userId } = requireUser(request);
    await requirePermission(request.params.guildId, userId, Permission.MANAGE_INVITES);

    const rows = await db
      .select()
      .from(invites)
      .where(eq(invites.guildId, request.params.guildId))
      .orderBy(asc(invites.createdAt));
    return rows.map(toInvite);
  });

  app.post<{ Params: { guildId: string } }>('/api/guilds/:guildId/invites', async (request, reply) => {
    const { userId } = requireUser(request);
    await requirePermission(
      request.params.guildId,
      userId,
      Permission.CREATE_INVITE,
      'You need the Create invites permission',
    );

    const parsed = createInviteSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw errors.invalid('Invalid invite settings');

    const expiresIn = parsed.data.expiresIn ?? 0;
    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

    // 32^8 is ~1.1e12 codes; a collision is vanishingly unlikely, but the
    // primary key would reject one and a silent 500 is a poor way to find out.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateInviteCode();
      const existing = await db.query.invites.findFirst({ where: eq(invites.code, code) });
      if (existing) continue;

      const [row] = await db
        .insert(invites)
        .values({
          code,
          guildId: request.params.guildId,
          createdBy: userId,
          expiresAt,
          maxUses: parsed.data.maxUses ?? 0,
        })
        .returning();
      if (row) return reply.code(201).send(toInvite(row));
    }
    throw errors.invalid('Could not allocate an invite code, please try again');
  });

  app.delete<{ Params: { code: string } }>('/api/invites/:code', async (request, reply) => {
    const { userId } = requireUser(request);
    const invite = await db.query.invites.findFirst({ where: eq(invites.code, request.params.code) });
    if (!invite) throw errors.notFound('That invite does not exist');

    // Revoking your own needs only the permission to have made it; revoking
    // someone else's is an administrative act.
    if (invite.createdBy !== userId) {
      await requirePermission(invite.guildId, userId, Permission.MANAGE_INVITES);
    } else {
      await memberContext(invite.guildId, userId);
    }

    await db.delete(invites).where(eq(invites.code, request.params.code));
    return reply.code(204).send();
  });

  app.post('/api/invites/join', async (request) => {
    const { userId } = requireUser(request);
    const parsed = joinByInviteSchema.safeParse(request.body);
    if (!parsed.success) throw errors.invalid('An invite code is required');

    const code = parsed.data.code.trim().toUpperCase();
    const invite = await db.query.invites.findFirst({ where: eq(invites.code, code) });
    if (!invite) throw errors.notFound('That invite is not valid');

    const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, invite.guildId) });
    if (!guild) throw errors.notFound('That server no longer exists');

    // Membership is checked before the invite's own validity: someone who is
    // already in should be told so, not that the code they pasted is expired or
    // used up. It costs them nothing and answers the question they asked.
    const already = await db.query.guildMembers.findFirst({
      where: and(eq(guildMembers.guildId, invite.guildId), eq(guildMembers.userId, userId)),
    });
    if (already) return { guild: toGuild(guild), joined: false };

    // A ban has to survive an invite, otherwise banning someone only lasts
    // until a friend sends them a fresh code.
    const banned = await db.query.bans.findFirst({
      where: and(eq(bans.guildId, invite.guildId), eq(bans.userId, userId)),
    });
    if (banned) throw errors.forbidden('You are banned from that server');

    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      throw errors.notFound('That invite has expired');
    }
    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
      throw errors.notFound('That invite has been used up');
    }

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw errors.unauthorized();

    // Membership and the use count move together: counting a use for a join
    // that failed would burn a single-use invite on nothing.
    const member = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(guildMembers)
        .values({ guildId: invite.guildId, userId })
        .returning();
      if (!inserted) throw errors.invalid('Could not join that server');

      await tx
        .update(invites)
        .set({ uses: sql`${invites.uses} + 1` })
        .where(eq(invites.code, code));

      return inserted;
    });

    registry.publishToGuild(invite.guildId, {
      op: 'guild:member_add',
      d: {
        guildId: member.guildId,
        userId: member.userId,
        nickname: member.nickname,
        joinedAt: member.joinedAt.toISOString(),
        rankIds: [],
        user: toPublicUser(user),
      },
    });

    return { guild: toGuild(guild), joined: true };
  });
}
