import { errors } from './errors.js';

/**
 * Data URL decoding for uploaded avatars and server icons.
 *
 * The client resizes images to 256x256 before upload, so anything arriving here
 * much larger than that is either a client bug or someone poking at the API
 * directly. Both are handled the same way: reject.
 */

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** 256x256 lands well under this even as lossless PNG. */
const MAX_BYTES = 512 * 1024;

/**
 * Magic-number prefixes. The declared MIME type in a data URL is attacker
 * controlled, so it is checked against what the bytes actually are - otherwise
 * an SVG (which can carry script) could be served back under an image/png
 * content type.
 */
const SIGNATURES: Array<{ mime: string; matches: (b: Buffer) => boolean }> = [
  { mime: 'image/png', matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    matches: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } {
  const match = /^data:([a-z]+\/[a-z0-9+.-]+);base64,(.*)$/i.exec(dataUrl);
  if (!match) throw errors.invalid('That image could not be read');

  const declaredMime = (match[1] ?? '').toLowerCase();
  if (!ALLOWED_MIME.has(declaredMime)) {
    throw errors.invalid('Upload a PNG, JPEG or WebP image');
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2] ?? '', 'base64');
  } catch {
    throw errors.invalid('That image could not be read');
  }

  if (bytes.length === 0) throw errors.invalid('That image is empty');
  if (bytes.length > MAX_BYTES) throw errors.invalid('That image is too large (512KB maximum)');

  const actual = SIGNATURES.find((sig) => sig.matches(bytes));
  if (!actual || actual.mime !== declaredMime) {
    throw errors.invalid('That file is not the image type it claims to be');
  }

  return { mimeType: actual.mime, bytes };
}
