import type { FastifyInstance } from 'fastify';
import {
  GatewayCloseCode,
  deleteAccountSchema,
  imageUploadSchema,
  updateProfileSchema,
} from '@chitchak/protocol';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  blocks,
  channels,
  dmChannels,
  friendships,
  guildMembers,
  guilds,
  images,
  invites,
  memberRanks,
  passwordResets,
  refreshTokens,
  users,
  voiceStates,
} from '../db/schema.js';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';
import { progress } from '../services/progress.js';
import { toPublicUser, toSelfUser } from '../services/serialize.js';
import { authenticate, requireUser } from './authenticate.js';
import { decodeDataUrl } from '../lib/images.js';

/**
 * Profile: who you are and what other people see.
 *
 * Any change here has to reach everyone who can see the user, which is everyone
 * sharing a guild with them - otherwise a renamed user keeps their old name in
 * every open client until it reconnects.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users/@me', {
    preHandler: authenticate,
    handler: async (request) => {
      const { userId } = requireUser(request);
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      if (!user) throw errors.unauthorized('Account no longer exists');
      return toSelfUser(user);
    },
  });

  app.patch('/api/users/@me', {
    preHandler: authenticate,
    handler: async (request) => {
      const { userId } = requireUser(request);
      const parsed = updateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        throw errors.invalid('Check the fields below', fieldErrors(parsed.error.issues));
      }

      const patch = parsed.data;
      const update: Partial<typeof users.$inferInsert> = {};

      if (patch.displayName !== undefined) update.displayName = patch.displayName.trim();
      if (patch.bio !== undefined) update.bio = patch.bio.trim() || null;
      if (patch.accentColor !== undefined) update.accentColor = patch.accentColor.toLowerCase();

      if (patch.username !== undefined) {
        const username = patch.username.trim().toLowerCase();
        // Excluding self, or re-saving the form without changing the username
        // would report it as taken by the person who already holds it.
        const taken = await db.query.users.findFirst({
          where: and(eq(users.username, username), ne(users.id, userId)),
        });
        if (taken) throw errors.invalid('That username is taken', { username: 'Already in use' });
        update.username = username;
      }

      if (Object.keys(update).length === 0) {
        const current = await db.query.users.findFirst({ where: eq(users.id, userId) });
        if (!current) throw errors.unauthorized();
        return toSelfUser(current);
      }

      const [updated] = await db.update(users).set(update).where(eq(users.id, userId)).returning();
      if (!updated) throw errors.unauthorized('Account no longer exists');

      await broadcastProfile(userId, updated);
      void progress(userId, 'profile');
      return toSelfUser(updated);
    },
  });

  app.put('/api/users/@me/avatar', {
    preHandler: authenticate,
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    handler: async (request) => {
      const { userId } = requireUser(request);
      const parsed = imageUploadSchema.safeParse(request.body);
      if (!parsed.success) {
        throw errors.invalid(parsed.error.issues[0]?.message ?? 'That image could not be read');
      }

      const image = decodeDataUrl(parsed.data.dataUrl);

      await db
        .insert(images)
        .values({ kind: 'user_avatar', ownerId: userId, mimeType: image.mimeType, data: image.bytes })
        .onConflictDoUpdate({
          target: [images.kind, images.ownerId],
          set: { mimeType: image.mimeType, data: image.bytes, updatedAt: new Date() },
        });

      // Incremented in SQL rather than read-modify-write: two uploads racing
      // could otherwise settle on the same version and leave one client
      // showing a stale cached image forever.
      const [updated] = await db
        .update(users)
        .set({ avatarVersion: sql`${users.avatarVersion} + 1` })
        .where(eq(users.id, userId))
        .returning();
      if (!updated) throw errors.unauthorized();

      await broadcastProfile(userId, updated);
      void progress(userId, 'profile');
      return toSelfUser(updated);
    },
  });

  app.delete('/api/users/@me/avatar', {
    preHandler: authenticate,
    handler: async (request) => {
      const { userId } = requireUser(request);
      await db
        .delete(images)
        .where(and(eq(images.kind, 'user_avatar'), eq(images.ownerId, userId)));

      // Version 0 is the "no avatar" sentinel the serializer checks.
      const [updated] = await db
        .update(users)
        .set({ avatarVersion: 0 })
        .where(eq(users.id, userId))
        .returning();
      if (!updated) throw errors.unauthorized();

      await broadcastProfile(userId, updated);
      return toSelfUser(updated);
    },
  });

  /**
   * Delete your own account.
   *
   * Erases the person, keeps the thread. The row survives - emptied of every
   * personal field - because messages.authorId cascades, so deleting it would
   * take every message they ever sent and leave everyone else's conversations
   * full of replies to nothing. What remains identifies nobody.
   *
   * Servers they own are the one thing this refuses to decide. Handing someone
   * else's community to an arbitrary member, or deleting it out from under its
   * users, are both worse than saying no and letting the owner choose.
   */
  app.delete('/api/users/@me', {
    // The tightest limit in the app. There is no legitimate reason to call this
    // more than once, and a wrong password should not be cheap to retry.
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: authenticate,
    handler: async (request, reply) => {
      const { userId } = requireUser(request);

      const parsed = deleteAccountSchema.safeParse(request.body);
      if (!parsed.success) {
        throw errors.invalid('Enter your password to confirm', {
          password: 'Required',
        });
      }

      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      if (!user || user.deletedAt) throw errors.unauthorized('Account no longer exists');

      if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
        throw errors.invalid('That password is not right', {
          password: 'Incorrect password',
        });
      }

      const owned = await db
        .select({ id: guilds.id, name: guilds.name })
        .from(guilds)
        .where(eq(guilds.ownerId, userId));

      if (owned.length > 0) {
        const names = owned.map((g) => g.name).join(', ');
        throw errors.conflict(
          `You still own ${owned.length === 1 ? 'a server' : `${owned.length} servers`}: ${names}. ` +
            'Transfer ownership or delete them first, then delete your account.',
        );
      }

      const now = new Date();

      await db.transaction(async (tx) => {
        // Both columns are uniquely indexed, so the placeholders have to stay
        // unique too - hence the id. `.invalid` is reserved by RFC 2606 and can
        // never be a real address, so nothing can be sent to it by accident.
        await tx
          .update(users)
          .set({
            email: `deleted+${user.id}@deleted.invalid`,
            username: `deleted_${user.id}`,
            displayName: 'Deleted User',
            bio: null,
            accentColor: null,
            avatarVersion: 0,
            // Not a hash of anything - it does not parse as one, so
            // verifyPassword rejects it without computing a thing.
            passwordHash: 'deleted',
            deletedAt: now,
            // Invalidates every access token already issued, which are
            // stateless and cannot be revoked one at a time.
            tokensValidFrom: now,
          })
          .where(eq(users.id, userId));

        // Nothing here cascades on its own, because the row is staying.
        await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
        await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
        await tx.delete(memberRanks).where(eq(memberRanks.userId, userId));
        await tx.delete(guildMembers).where(eq(guildMembers.userId, userId));
        await tx.delete(voiceStates).where(eq(voiceStates.userId, userId));
        // Their invites stop working: a link handed out by an account that no
        // longer exists should not keep letting strangers in.
        await tx.delete(invites).where(eq(invites.createdBy, userId));
        // images has no foreign key at all - ownerId is a plain text column -
        // so the avatar would otherwise sit in the database forever.
        await tx
          .delete(images)
          .where(and(eq(images.kind, 'user_avatar'), eq(images.ownerId, userId)));

        // Relationships end. Nobody should be left with "Deleted User" in their
        // friends list, and a block against an account that no longer acts is
        // protecting against nothing.
        await tx
          .delete(friendships)
          .where(or(eq(friendships.userA, userId), eq(friendships.userB, userId)));
        await tx
          .delete(blocks)
          .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));

        // The conversations go with them, and this is the one place messages
        // are not kept.
        //
        // The rule elsewhere - anonymise, keep the thread - exists so other
        // people's conversations still read. A DM had exactly two people in it:
        // one is gone, and the other cannot reply, because replying needs a
        // friendship that no longer exists. What would survive is an
        // unreachable channel nobody can act in.
        //
        // Deleting the channel row is what does the work; dm_channels and the
        // messages inside it follow by cascade.
        const conversations = await tx
          .select({ channelId: dmChannels.channelId })
          .from(dmChannels)
          .where(or(eq(dmChannels.userA, userId), eq(dmChannels.userB, userId)));

        if (conversations.length > 0) {
          await tx.delete(channels).where(
            inArray(
              channels.id,
              conversations.map((row) => row.channelId),
            ),
          );
        }
      });

      // Tokens are dead, but an open socket authenticated a while ago and is
      // still connected. Close it rather than waiting for its next heartbeat.
      for (const session of registry.localSessionsFor(userId)) {
        session.close(GatewayCloseCode.AuthenticationFailed, 'account deleted');
      }

      request.log.info({ userId }, 'account deleted and anonymised');
      return reply.code(204).send();
    },
  });

  // Serving the avatar image itself lives in images.routes.ts, which is
  // registered without an auth hook so `<img src>` works.
}

/** Push a profile change to everyone who shares a server with this user. */
async function broadcastProfile(
  userId: string,
  row: typeof users.$inferSelect,
): Promise<void> {
  const memberships = await db
    .select({ guildId: guildMembers.guildId })
    .from(guildMembers)
    .where(eq(guildMembers.userId, userId));

  const payload = toPublicUser(row);
  for (const { guildId } of memberships) {
    registry.publishToGuild(guildId, { op: 'user:update', d: payload });
  }
  // The user's own other clients may share no guild with them at all (a brand
  // new account), so they are told directly as well.
  registry.sendToLocalUser(userId, { op: 'user:update', d: payload });
}

function fieldErrors(issues: Array<{ path: PropertyKey[]; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'body';
    out[key] ??= issue.message;
  }
  return out;
}
