import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { attachments } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { readStored, store } from '../lib/storage.js';
import {
  imageSize,
  isInline,
  maxBytesFor,
  serializeAttachment,
  sniff,
  verifySignature,
} from '../services/attachments.js';
import { authenticate, requireUser } from './authenticate.js';

/**
 * Uploading a file, and fetching one back.
 *
 * Deliberately two separate registrations. Uploading needs a signed-in user and
 * a raw body of up to a hundred megabytes; downloading needs neither, because
 * the signed URL is the credential and the request comes from an `<img src>`
 * that cannot carry a header. Keeping them apart means no `preHandler` can
 * close the download route by accident, and no body parser touches it.
 */

/** How much of the file to hold in memory for sniffing and dimensions. */
const HEAD_BYTES = 64 * 1024;

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  /*
    A raw body rather than multipart. One file per request needs none of what
    multipart offers, and a parser that hands over the stream untouched lets the
    bytes go to disk as they arrive instead of being buffered - which is the
    difference between a hundred-megabyte upload costing a hundred megabytes of
    disk and costing a hundred megabytes of memory as well.
  */
  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload);
  });

  app.post<{ Querystring: { name?: string } }>(
    '/api/uploads',
    async (request, reply) => {
      const { userId } = requireUser(request);

      const name = (request.query.name ?? '').trim().slice(0, 200);
      if (!name) throw errors.invalid('The upload is missing a filename');

      // Read after authenticating, so the cap is the one this account actually
      // has rather than the largest anyone could have.
      const maxBytes = await maxBytesFor(userId);

      let stored;
      try {
        stored = await store(request.body as Readable, maxBytes);
      } catch (error) {
        /*
          The refusal happened part-way through the body, which leaves the rest
          of the file still arriving on a connection nobody is reading. Keeping
          it alive means the next request sent down it is answered by the tail
          of an abandoned upload - which shows up as a connection reset on a
          request that has nothing wrong with it.

          Closing is the honest answer: we stopped listening, so the connection
          is finished. Without this the size limit works and quietly breaks the
          request after it.
        */
        reply.header('Connection', 'close');
        throw error;
      }

      /*
        What the bytes are, not what the request said they were. A client can
        put anything in Content-Type, and the type decides whether the browser
        is later allowed to render the file in place.
      */
      const head = await readHead(stored.sha256);
      const mimeType = sniff(head);
      const size = isInline(mimeType) ? imageSize(head, mimeType) : null;

      const [row] = await db
        .insert(attachments)
        .values({
          id: generateId(),
          messageId: null,
          uploaderId: userId,
          // Path separators stripped: this is only ever a download filename,
          // and it should not be able to look like a path anywhere it lands.
          name: name.replace(/[/\\]/g, '_'),
          mimeType,
          bytes: stored.bytes,
          sha256: stored.sha256,
          width: size?.width ?? null,
          height: size?.height ?? null,
        })
        .returning();

      if (!row) throw errors.invalid('That file could not be stored');
      return serializeAttachment(row);
    },
  );
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { expires?: string; signature?: string } }>(
    '/api/attachments/:id',
    async (request, reply) => {
      const { id } = request.params;
      const { expires, signature } = request.query;
      if (!expires || !signature) throw errors.forbidden('That link is not valid');

      verifySignature(id, expires, signature);

      const row = await db.query.attachments.findFirst({ where: eq(attachments.id, id) });
      if (!row) throw errors.notFound('That file is no longer here');

      /*
        Anything not on the inline allowlist is sent as a download.

        This is the line that stops an upload being used as a way to serve HTML
        or a script-carrying SVG from the API's own origin. `nosniff` is what
        makes it stick: without it a browser is free to disregard the declared
        type and guess from the content, which is precisely the behaviour being
        defended against.
      */
      const inline = isInline(row.mimeType);
      const filename = row.name.replace(/["\\]/g, '');

      return reply
        .type(inline ? row.mimeType : 'application/octet-stream')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
        )
        .header('Content-Length', String(row.bytes))
        // The bytes at a given id never change, so this is safe to hold for as
        // long as the link itself is good for.
        .header('Cache-Control', 'private, max-age=86400')
        .send(readStored(row.sha256));
    },
  );
}

/** The first chunk of a stored file, for sniffing and dimensions. */
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
