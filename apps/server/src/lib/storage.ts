import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { errors } from './errors.js';

/**
 * Where uploaded files live.
 *
 * On disk rather than in Postgres, which is where avatars live. At 256x256 an
 * avatar is tens of kilobytes and having it inside the database backup is a
 * feature; a hundred-megabyte video is the opposite, and would put every one
 * of them into every `pg_dump` from then on.
 *
 * Content addressed: the path is derived from the SHA-256 of the bytes, so the
 * same file sent by five people is stored once, an interrupted upload leaves
 * nothing behind to reconcile, and a row can never point at a path that was
 * computed by different logic than the one that wrote it.
 *
 * Backups are `scripts/backup.sh`, which now archives this directory alongside
 * the database dump. A restore of one without the other gives messages whose
 * attachments 404.
 */

export const UPLOAD_DIR = process.env.CHITCHAK_UPLOAD_DIR ?? '/data/uploads';

/**
 * Two levels of two hex characters, so no directory holds more than a few
 * thousand entries. Filesystems cope with enormous directories but every tool
 * that has to list one does not.
 */
function shardedPath(sha256: string): string {
  return path.join(UPLOAD_DIR, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function storedPath(sha256: string): string {
  return shardedPath(sha256);
}

export interface Stored {
  sha256: string;
  bytes: number;
}

/**
 * Streams an upload to disk, refusing it the moment it is too big.
 *
 * The limit is enforced while the bytes arrive rather than after, because
 * "after" means a hundred and one megabytes have already been written to
 * accept a hundred-megabyte cap. Anyone can open a socket and send forever;
 * the only defence is to stop reading.
 *
 * Written to a temporary name first and moved into place at the end, so a
 * dropped connection can never leave a half-written file sitting at the path a
 * complete one would have.
 */
export async function store(source: Readable, maxBytes: number): Promise<Stored> {
  await mkdir(UPLOAD_DIR, { recursive: true });

  const temp = path.join(UPLOAD_DIR, `.incoming-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hash = createHash('sha256');
  let bytes = 0;
  let tooBig = false;

  const measure = async function* (chunks: AsyncIterable<Buffer>) {
    for await (const chunk of chunks) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        tooBig = true;
        // Ends the pipeline, which destroys the request stream and stops the
        // sender rather than politely reading the rest of the file first.
        return;
      }
      hash.update(chunk);
      yield chunk;
    }
  };

  try {
    await pipeline(source, measure, createWriteStream(temp));
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }

  if (tooBig) {
    await rm(temp, { force: true });
    throw errors.invalid(`That file is larger than ${Math.round(maxBytes / (1024 * 1024))}MB`);
  }
  if (bytes === 0) {
    await rm(temp, { force: true });
    throw errors.invalid('That file is empty');
  }

  const sha256 = hash.digest('hex');
  const destination = shardedPath(sha256);

  // Already have these exact bytes, from anyone: keep the copy that is there
  // and drop this one. Identical content, so there is nothing to choose
  // between them.
  if (await exists(destination)) {
    await rm(temp, { force: true });
    return { sha256, bytes };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await rename(temp, destination);
  return { sha256, bytes };
}

export function readStored(sha256: string): Readable {
  return createReadStream(shardedPath(sha256));
}

export async function removeStored(sha256: string): Promise<void> {
  await rm(shardedPath(sha256), { force: true });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
