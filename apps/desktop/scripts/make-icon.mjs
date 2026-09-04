import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates the app icon: the level meter, on graphite.
 *
 * Written by hand rather than pulled from an image library because the mark is
 * three rectangles and a background - encoding that as a PNG is less code than
 * adding an image dependency, and it keeps the icon in the repo as something
 * that can be re-generated rather than a binary nobody can edit.
 */

const SIZE = 256;

const GRAPHITE = [0x17, 0x16, 0x1a];
const BRASS = [0xd9, 0xa4, 0x5b];
const SIGNAL = [0x4f, 0xd6, 0xc4];

/** Three bars, middle one tallest - the same shape the meter draws in the app. */
const BARS = [
  { x: 62, width: 34, height: 96, color: BRASS },
  { x: 111, width: 34, height: 168, color: SIGNAL },
  { x: 160, width: 34, height: 124, color: BRASS },
];

const RADIUS = 44; // Rounded app-icon corner.
const BAR_RADIUS = 10;

function insideRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px >= x + w || py < y || py >= y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Sampled 3x3 per pixel so the curves are not jagged. */
function coverage(px, py, test) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      if (test(px + (sx + 0.5) / 3, py + (sy + 0.5) / 3)) hits += 1;
    }
  }
  return hits / 9;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));

for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // PNG filter type: none.

  for (let x = 0; x < SIZE; x += 1) {
    const bgAlpha = coverage(x, y, (px, py) => insideRoundedRect(px, py, 0, 0, SIZE, SIZE, RADIUS));

    let r = GRAPHITE[0];
    let g = GRAPHITE[1];
    let b = GRAPHITE[2];

    for (const bar of BARS) {
      const top = (SIZE - bar.height) / 2;
      const cov = coverage(x, y, (px, py) =>
        insideRoundedRect(px, py, bar.x, top, bar.width, bar.height, BAR_RADIUS),
      );
      if (cov > 0) {
        r = Math.round(r * (1 - cov) + bar.color[0] * cov);
        g = Math.round(g * (1 - cov) + bar.color[1] * cov);
        b = Math.round(b * (1 - cov) + bar.color[2] * cov);
      }
    }

    const offset = rowStart + 1 + x * 4;
    raw[offset] = r;
    raw[offset + 1] = g;
    raw[offset + 2] = b;
    raw[offset + 3] = Math.round(bgAlpha * 255);
  }
}

// --- PNG container ---------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// --- ICO container ---------------------------------------------------------
// A single 256x256 entry holding the PNG verbatim, which Windows has accepted
// since Vista. 0 in the size byte means 256.

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // one image

const entry = Buffer.alloc(16);
entry[0] = 0; // width 256
entry[1] = 0; // height 256
entry[2] = 0; // palette size
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // colour planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, entry, png]));
writeFileSync(path.join(dir, 'icon.png'), png);

console.log(`Wrote build/icon.ico and build/icon.png (${SIZE}x${SIZE}, ${png.length} bytes)`);
