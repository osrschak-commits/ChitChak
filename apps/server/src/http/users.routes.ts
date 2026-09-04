import type { FastifyInstance } from 'fastify';
import { imageUploadSchema, updateProfileSchema } from '@chitchak/protocol';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { guildMembers, images, users } from '../db/schema.js';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
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
