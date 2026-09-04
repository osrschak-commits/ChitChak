import { Permission, banMemberSchema, voiceModerationSchema } from '@chitchak/protocol';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { bans, guildMembers, guilds, messages, users, voiceStates } from '../db/schema.js';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
import { memberContext, requireOutranks, requirePermission } from '../services/permissions.js';
import { toBan, toVoiceState } from '../services/serialize.js';
import { removeParticipant, setServerDeafen, setServerMute } from '../voice/livekit.js';
import { moveToChannel } from '../voice/service.js';
import { authenticate, requireUser } from './authenticate.js';

/**
 * Moderation: kick, ban, and the voice powers ranks exist to grant.
 *
 * Every action here is gated on both a permission and the hierarchy check -
 * holding MUTE_MEMBERS lets you mute people below you, not your peers.
 */
export async function moderationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.delete<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/members/:userId',
    async (request, reply) => {
      const { userId: actorId } = requireUser(request);
      const actor = await requirePermission(
        request.params.guildId,
        actorId,
        Permission.KICK_MEMBERS,
        'You need the Kick members permission',
      );
      await requireOutranks(actor, request.params.userId);

      await removeFromGuild(request.params.guildId, request.params.userId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/bans', async (request) => {
    const { userId } = requireUser(request);
    await requirePermission(request.params.guildId, userId, Permission.BAN_MEMBERS);

    const rows = await db
      .select({ ban: bans, user: users })
      .from(bans)
      .innerJoin(users, eq(users.id, bans.userId))
      .where(eq(bans.guildId, request.params.guildId))
      .orderBy(desc(bans.createdAt));

    return rows.map((r) => toBan(r.ban, r.user));
  });

  app.put<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/bans/:userId',
    async (request, reply) => {
      const { userId: actorId } = requireUser(request);
      const actor = await requirePermission(
        request.params.guildId,
        actorId,
        Permission.BAN_MEMBERS,
        'You need the Ban members permission',
      );

      const parsed = banMemberSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw errors.invalid('Invalid ban');

      // Someone can be banned without currently being a member - pre-emptively,
      // or after they left. Only run the hierarchy check when they are here to
      // outrank.
      const membership = await db.query.guildMembers.findFirst({
        where: and(
          eq(guildMembers.guildId, request.params.guildId),
          eq(guildMembers.userId, request.params.userId),
        ),
      });
      if (membership) await requireOutranks(actor, request.params.userId);

      const target = await db.query.users.findFirst({
        where: eq(users.id, request.params.userId),
      });
      if (!target) throw errors.notFound('No such person');

      await db
        .insert(bans)
        .values({
          guildId: request.params.guildId,
          userId: request.params.userId,
          reason: parsed.data.reason ?? null,
          bannedBy: actorId,
        })
        .onConflictDoUpdate({
          target: [bans.guildId, bans.userId],
          set: { reason: parsed.data.reason ?? null, bannedBy: actorId },
        });

      if (parsed.data.deleteMessages) {
        // Last 24 hours, the window that matters after a raid.
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const removed = await db
          .delete(messages)
          .where(and(eq(messages.authorId, request.params.userId), gt(messages.createdAt, cutoff)))
          .returning();

        for (const message of removed) {
          registry.publishToGuild(request.params.guildId, {
            op: 'message:delete',
            d: { channelId: message.channelId, messageId: message.id },
          });
        }
      }

      if (membership) await removeFromGuild(request.params.guildId, request.params.userId);

      const [row] = await db
        .select({ ban: bans, user: users })
        .from(bans)
        .innerJoin(users, eq(users.id, bans.userId))
        .where(
          and(eq(bans.guildId, request.params.guildId), eq(bans.userId, request.params.userId)),
        );

      return reply.code(201).send(row ? toBan(row.ban, row.user) : null);
    },
  );

  app.delete<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/bans/:userId',
    async (request, reply) => {
      const { userId: actorId } = requireUser(request);
      await requirePermission(request.params.guildId, actorId, Permission.BAN_MEMBERS);

      const [removed] = await db
        .delete(bans)
        .where(
          and(eq(bans.guildId, request.params.guildId), eq(bans.userId, request.params.userId)),
        )
        .returning();
      if (!removed) throw errors.notFound('That person is not banned');

      return reply.code(204).send();
    },
  );

  /**
   * Voice moderation: server mute, move between channels, disconnect.
   *
   * A server mute is enforced by the SFU rather than by asking the client
   * nicely, which is the difference between a moderation tool and a suggestion.
   */
  app.patch<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/members/:userId/voice',
    async (request) => {
      const { userId: actorId } = requireUser(request);
      const actor = await memberContext(request.params.guildId, actorId);

      const parsed = voiceModerationSchema.safeParse(request.body);
      if (!parsed.success) throw errors.invalid('Invalid voice action');

      const state = await db.query.voiceStates.findFirst({
        where: eq(voiceStates.userId, request.params.userId),
      });
      if (!state || state.guildId !== request.params.guildId) {
        throw errors.invalid('That person is not in a voice channel here');
      }

      await requireOutranks(actor, request.params.userId);

      // Mute and deafen share the MUTE_MEMBERS permission: both are "stop this
      // person participating in audio", and splitting them would be a
      // distinction without a difference for the person holding the power.
      if (parsed.data.serverMuted !== undefined || parsed.data.serverDeafened !== undefined) {
        await requirePermission(request.params.guildId, actorId, Permission.MUTE_MEMBERS);

        const update: Partial<typeof voiceStates.$inferInsert> = {};

        if (parsed.data.serverDeafened !== undefined) {
          await setServerDeafen(state.channelId, request.params.userId, parsed.data.serverDeafened);
          update.serverDeafened = parsed.data.serverDeafened;
          // Deafening implies muting, the same rule self-deafen follows.
          if (parsed.data.serverDeafened) update.serverMuted = true;
        }

        if (parsed.data.serverMuted !== undefined) {
          await setServerMute(state.channelId, request.params.userId, parsed.data.serverMuted);
          update.serverMuted = parsed.data.serverMuted;
        }

        const [updated] = await db
          .update(voiceStates)
          .set(update)
          .where(eq(voiceStates.userId, request.params.userId))
          .returning();

        if (updated) {
          registry.publishToGuild(request.params.guildId, {
            op: 'voice:state',
            d: toVoiceState(updated),
          });
        }
      }

      if (parsed.data.channelId !== undefined) {
        await requirePermission(request.params.guildId, actorId, Permission.MOVE_MEMBERS);

        if (parsed.data.channelId === null) {
          await removeParticipant(state.channelId, request.params.userId).catch(() => {});
          await db.delete(voiceStates).where(eq(voiceStates.userId, request.params.userId));
          registry.publishToGuild(request.params.guildId, {
            op: 'voice:state',
            d: { ...toVoiceState(state), channelId: null },
          });
        } else {
          await moveToChannel(request.params.userId, parsed.data.channelId);
        }
      }

      return { ok: true };
    },
  );
}

/**
 * Removes someone from a guild and tears down anything that outlives the
 * membership row - their voice session, and their place in everyone's client.
 */
async function removeFromGuild(guildId: string, userId: string): Promise<void> {
  const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, guildId) });
  if (guild?.ownerId === userId) throw errors.invalid('The server owner cannot be removed');

  const voice = await db.query.voiceStates.findFirst({ where: eq(voiceStates.userId, userId) });
  if (voice && voice.guildId === guildId) {
    await removeParticipant(voice.channelId, userId).catch(() => {});
    await db.delete(voiceStates).where(eq(voiceStates.userId, userId));
  }

  await db
    .delete(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)));

  registry.publishToGuild(guildId, {
    op: 'guild:member_remove',
    d: { guildId, userId },
  });
  // They are no longer a member, so the guild broadcast will not reach them.
  registry.publishToUsers([userId], { op: 'guild:delete', d: { guildId } });
}
