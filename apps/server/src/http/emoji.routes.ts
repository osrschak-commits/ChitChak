import { Permission } from '@chitchak/protocol';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { guildEmoji } from '../db/schema.js';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { readStored, store } from '../lib/storage.js';
import { sniff } from '../services/attachments.js';
import {
  MAX_BYTES,
  MAX_PER_GUILD,
  assertUsableImage,
  countIn,
  forGuild,
  normaliseName,
  remove,
  requireSubscriber,
  toEmoji,
} from '../services/emoji.js';
import { requirePermission } from '../services/permissions.js';
import { authenticate, requireUser } from './authenticate.js';

/**
 * Adding, removing and serving custom emoji.
 *
 * Split the same way attachments are: managing them needs a signed-in user and
 * a raw body, serving them needs neither. An emoji goes into an `<img src>` on
 * every message that uses it, so its URL has to work without a header - and
 * unlike an attachment it is decoration shown to the whole server, so it is
 * served like an avatar: unsigned, stable and cached hard.
 */

/** Enough to sniff the type and be sure of it. */
const HEAD_BYTES = 32 * 1024;

export async function emojiManageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload);
  });

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/emoji', async (request) => {
    const { userId } = requireUser(request);
    // Seeing the list is ordinary membership - you can use these, so you can
    // see them.
    await requirePermission(request.params.guildId, userId, Permission.VIEW_CHANNEL);
    return { emoji: await forGuild(request.params.guildId) };
  });

  app.post<{ Params: { guildId: string }; Querystring: { name?: string } }>(
    '/api/guilds/:guildId/emoji',
    async (request, reply) => {
      const { userId } = requireUser(request);
      const { guildId } = request.params;

      await requirePermission(
        guildId,
        userId,
        Permission.MANAGE_SERVER,
        'You do not have permission to change this server',
      );
      await requireSubscriber(userId);

      const name = normaliseName(request.query.name);

      if ((await countIn(guildId)) >= MAX_PER_GUILD) {
        throw errors.invalid(`This server already has ${MAX_PER_GUILD} emoji`);
      }

      let stored;
      try {
        stored = await store(request.body as Readable, MAX_BYTES);
      } catch (error) {
        // The body was abandoned part-way, so the connection cannot be reused.
        // See the same note in attachments.routes.ts.
        reply.header('Connection', 'close');
        throw error;
      }

      const head = await readHead(stored.sha256);
      const mimeType = sniff(head);
      assertUsableImage(mimeType);

      const [row] = await db
        .insert(guildEmoji)
        .values({
          id: generateId(),
          guildId,
          name,
          mimeType,
          sha256: stored.sha256,
          bytes: stored.bytes,
          creatorId: userId,
        })
        .onConflictDoNothing()
        .returning();

      // The unique index on (guild, name) is what decides this, not a lookup
      // beforehand - two people adding `:yes:` at once would both pass a check
      // and one would still have to lose.
      if (!row) throw errors.invalid(`This server already has an emoji called :${name}:`);

      const emoji = toEmoji(row);
      registry.publishToGuild(guildId, { op: 'emoji:create', d: emoji });
      return emoji;
    },
  );

  app.delete<{ Params: { guildId: string; emojiId: string } }>(
    '/api/guilds/:guildId/emoji/:emojiId',
    async (request) => {
      const { userId } = requireUser(request);
      const { guildId, emojiId } = request.params;

      // Deliberately no subscription check. Taking something down is not a
      // premium action, and somebody whose subscription lapsed must still be
      // able to tidy up after themselves.
      await requirePermission(
        guildId,
        userId,
        Permission.MANAGE_SERVER,
        'You do not have permission to change this server',
      );

      await remove(guildId, emojiId);
      registry.publishToGuild(guildId, { op: 'emoji:delete', d: { guildId, emojiId } });
      return { ok: true };
    },
  );
}

export async function emojiServeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { emojiId: string } }>('/api/emoji/:emojiId', async (request, reply) => {
    const row = await db.query.guildEmoji.findFirst({
      where: eq(guildEmoji.id, request.params.emojiId),
    });
    if (!row) throw errors.notFound('No such emoji');

    return reply
      .type(row.mimeType)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Length', String(row.bytes))
      // An emoji's id never points at different bytes: changing the picture
      // means a new emoji. So this can be cached for as long as anyone likes.
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(readStored(row.sha256));
  });
}

async function readHead(sha256: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = readStored(sha256);
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    chunks.push(buffer);
    total += buffer.length;
    if (total >= HEAD_BYTES) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, HEAD_BYTES);
}
