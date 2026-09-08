import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { attachments, type AttachmentRow } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { removeStored } from '../lib/storage.js';
import { standingOf } from './subscriptions.js';

/**
 * Files sent with messages.
 *
 * Two things here are worth reading before changing anything: what a file is
 * allowed to be, and who is allowed to fetch it back.
 */

/** What a free account may send. */
export const FREE_MAX_BYTES = 10 * 1024 * 1024;
/** What Brass may send. */
export const SUBSCRIBER_MAX_BYTES = 100 * 1024 * 1024;

export async function maxBytesFor(userId: string): Promise<number> {
  return (await standingOf(userId)).active ? SUBSCRIBER_MAX_BYTES : FREE_MAX_BYTES;
}

/**
 * Types the browser may render in place.
 *
 * An allowlist, and a short one. Anything not here is sent with
 * `Content-Disposition: attachment` so the browser downloads it rather than
 * interpreting it - which is the whole defence against somebody uploading a
 * file that is really HTML, or an SVG with a script in it, and passing the link
 * around as a picture. SVG is deliberately absent for exactly that reason.
 */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isInline(mimeType: string): boolean {
  return INLINE_TYPES.has(mimeType);
}

/**
 * What the bytes actually are.
 *
 * The declared content type is whatever the uploader felt like sending, so it
 * is never trusted. Anything unrecognised is stored as
 * `application/octet-stream`: still downloadable, never interpreted.
 */
export function sniff(head: Buffer): string {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString('ascii');

  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') return 'video/mp4';
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) {
    return 'application/zip';
  }
  return 'application/octet-stream';
}

/**
 * Width and height, read out of the header rather than by decoding.
 *
 * Sent to the client so it can reserve the space before the image arrives.
 * Without it every picture in the channel pops in at its natural size and
 * shoves the conversation down as you are reading it.
 */
export function imageSize(head: Buffer, mimeType: string): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png' && head.length >= 24) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }

    if (mimeType === 'image/gif' && head.length >= 10) {
      return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
    }

    if (mimeType === 'image/webp' && head.length >= 30) {
      const kind = head.subarray(12, 16).toString('ascii');
      // Three container flavours, and they store the size in three places.
      if (kind === 'VP8 ') {
        return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
      }
      if (kind === 'VP8L') {
        const bits = head.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') {
        const w = head[24]! | (head[25]! << 8) | (head[26]! << 16);
        const h = head[27]! | (head[28]! << 8) | (head[29]! << 16);
        return { width: w + 1, height: h + 1 };
      }
      return null;
    }

    if (mimeType === 'image/jpeg') {
      // JPEG has no fixed header: walk the segments to the frame marker that
      // carries the dimensions, skipping everything else by its length.
      let at = 2;
      while (at + 9 < head.length) {
        if (head[at] !== 0xff) {
          at += 1;
          continue;
        }
        const marker = head[at + 1]!;
        const length = head.readUInt16BE(at + 2);
        // SOF0..SOF15, minus the four that are not start-of-frame markers.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: head.readUInt16BE(at + 7), height: head.readUInt16BE(at + 5) };
        }
        at += 2 + length;
      }
      return null;
    }
  } catch {
    // A truncated or malformed header is not a reason to refuse the upload;
    // the client simply does not get to reserve the space.
    return null;
  }
  return null;
}

/* --- Fetching one back ----------------------------------------------------- */

/**
 * How long a link to an attachment is good for.
 *
 * These URLs go into `<img src>`, which cannot carry an Authorization header,
 * so the URL has to be the credential. Signing it rather than relying on an
 * unguessable id means a link that leaks stops working, instead of being
 * valid for as long as the file exists.
 *
 * The permission check happens when the message is delivered, not on every
 * fetch: if you were allowed to see the message you were given a signed link,
 * and that link expires. A day is long enough that a channel left open all
 * afternoon keeps working, and short enough that a link pasted elsewhere is
 * dead by tomorrow.
 */
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

function signature(id: string, expires: number): string {
  return createHmac('sha256', config.JWT_SECRET)
    .update(`${id}:${expires}`)
    .digest('base64url');
}

export function signedUrl(id: string): string {
  const expires = Date.now() + LINK_TTL_MS;
  return `/api/attachments/${id}?expires=${expires}&signature=${signature(id, expires)}`;
}

export function verifySignature(id: string, expires: string, provided: string): void {
  const at = Number(expires);
  if (!Number.isFinite(at)) throw errors.forbidden('That link is not valid');
  if (at < Date.now()) throw errors.forbidden('That link has expired. Reopen the channel.');

  const expected = Buffer.from(signature(id, at));
  const actual = Buffer.from(provided);
  // Compared in constant time, and only after the lengths match - timingSafeEqual
  // throws on a length mismatch, which would itself be a signal.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw errors.forbidden('That link is not valid');
  }
}

/* --- Serialising ----------------------------------------------------------- */

export interface SerializedAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Signed, and good for a day. */
  url: string;
}

export function serializeAttachment(row: AttachmentRow): SerializedAttachment {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    url: signedUrl(row.id),
  };
}

/** Every attachment on a set of messages, grouped by message. */
export async function forMessages(messageIds: string[]): Promise<Map<string, SerializedAttachment[]>> {
  const grouped = new Map<string, SerializedAttachment[]>();
  if (messageIds.length === 0) return grouped;

  const rows = await db.select().from(attachments).where(inArray(attachments.messageId, messageIds));
  for (const row of rows) {
    if (!row.messageId) continue;
    const list = grouped.get(row.messageId) ?? [];
    list.push(serializeAttachment(row));
    grouped.set(row.messageId, list);
  }
  return grouped;
}

/**
 * Claims uploads for a message that is being sent.
 *
 * Only rows the sender uploaded and has not already attached, which is what
 * stops somebody sending a message that carries a file they were merely shown
 * the id of.
 */
export async function attachToMessage(
  attachmentIds: string[],
  messageId: string,
  uploaderId: string,
): Promise<void> {
  if (attachmentIds.length === 0) return;

  const claimed = await db
    .update(attachments)
    .set({ messageId })
    .where(
      and(
        inArray(attachments.id, attachmentIds),
        eq(attachments.uploaderId, uploaderId),
        isNull(attachments.messageId),
      ),
    )
    .returning({ id: attachments.id });

  if (claimed.length !== attachmentIds.length) {
    throw errors.invalid('One of those files is no longer available. Try attaching it again.');
  }
}

/**
 * Deletes uploads that never became a message.
 *
 * Picking a file and then thinking better of it leaves a row and a file with
 * nothing pointing at them. Without this they accumulate silently, and the
 * first anyone hears of it is the disk being full.
 */
export async function sweepOrphans(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const orphans = await db
    .select({ id: attachments.id, sha256: attachments.sha256 })
    .from(attachments)
    .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
    .limit(500);

  if (orphans.length === 0) return 0;

  await db.delete(attachments).where(inArray(attachments.id, orphans.map((row) => row.id)));

  // The row is gone; the file only goes if nothing else points at those bytes.
  // Storage is content addressed, so two people sending the same picture share
  // one file and deleting either row must not take it away from the other.
  for (const orphan of orphans) {
    const [still] = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.sha256, orphan.sha256))
      .limit(1);
    if (!still) await removeStored(orphan.sha256);
  }

  return orphans.length;
}
