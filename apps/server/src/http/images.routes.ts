import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../db/client.js';
import { images } from '../db/schema.js';
import { errors } from '../lib/errors.js';

/**
 * Avatars and server icons.
 *
 * Unauthenticated on purpose, and registered separately from the authenticated
 * route groups so no `preHandler` hook can accidentally close them: these URLs
 * go straight into an `<img src>`, and requiring an Authorization header would
 * mean fetching every avatar through JavaScript and juggling blob URLs.
 *
 * The ids are unguessable snowflakes and the images are not sensitive, so the
 * exposure is a stranger who already knows a user id being able to see that
 * user's avatar.
 */
export async function imageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { userId: string } }>('/api/users/:userId/avatar', async (request, reply) => {
    return sendImage(reply, 'user_avatar', request.params.userId);
  });

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/icon', async (request, reply) => {
    return sendImage(reply, 'guild_icon', request.params.guildId);
  });
}

async function sendImage(
  reply: FastifyReply,
  kind: 'user_avatar' | 'guild_icon',
  ownerId: string,
): Promise<FastifyReply> {
  const row = await db.query.images.findFirst({
    where: and(eq(images.kind, kind), eq(images.ownerId, ownerId)),
  });
  if (!row) throw errors.notFound('No image set');

  return reply
    .type(row.mimeType)
    // Safe to cache hard: the URL carries a version that changes with the image.
    .header('Cache-Control', 'public, max-age=31536000, immutable')
    .send(row.data);
}
