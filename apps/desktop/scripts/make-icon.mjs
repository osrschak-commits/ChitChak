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
 *
 * Three files come out of it, because the three platforms disagree about
 * everything: icon.ico for Windows, icon.icns for macOS, and icon.png as the
 * plain source of truth.
 */

const GRAPHITE = [0x17, 0x16, 0x1a];
const BRASS = [0xd9, 0xa4, 0x5b];
const SIGNAL = [0x4f, 0xd6, 0xc4];

/**
 * The mark, in fractions of the square it is drawn in rather than pixels, so
 * the same geometry renders at 16px and at 1024px.
 *
 * Three bars, middle one tallest - the same shape the meter draws in the app.
 */
const BARS = [
  { x: 62 / 256, width: 34 / 256, height: 96 / 256, color: BRASS },
  { x: 111 / 256, width: 34 / 256, height: 168 / 256, color: SIGNAL },
  { x: 160 / 256, width: 34 / 256, height: 124 / 256, color: BRASS },
];

const BAR_RADIUS = 10 / 256;

/**
 * Corner rounding, as a fraction of the square the artwork occupies.
 *
 * Windows draws the icon full-bleed with a modest radius; macOS expects the
 * squircle to sit inside a margin, at a much rounder corner. Getting the mac
 * one wrong is immediately obvious in the Dock, where every neighbouring icon
 * is the right shape.
 */
const WINDOWS_RADIUS = 44 / 256;
const MACOS_RADIUS = 0.2237;

/**
 * How much of the canvas macOS leaves empty around an app icon. Apple's own
 * grid puts the rounded-rect at roughly 80% of the canvas width; the space is
 * what the Dock's magnification and drop shadow live in.
 */
const MACOS_MARGIN = 0.098;

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

/**
 * Renders the icon into a PNG buffer.
 *
 * @param size    edge length in pixels
 * @param margin  fraction of the canvas left empty on each side
 * @param radius  corner rounding, as a fraction of the artwork's edge
 */
function renderPng(size, { margin = 0, radius = WINDOWS_RADIUS } = {}) {
  const inset = Math.round(size * margin);
  const edge = size - inset * 2;

  const raw = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // PNG filter type: none.

    for (let x = 0; x < size; x += 1) {
      const bgAlpha = coverage(x, y, (px, py) =>
        insideRoundedRect(px, py, inset, inset, edge, edge, radius * edge),
      );

      let r = GRAPHITE[0];
      let g = GRAPHITE[1];
      let b = GRAPHITE[2];

      for (const bar of BARS) {
        const barWidth = bar.width * edge;
        const barHeight = bar.height * edge;
        const left = inset + bar.x * edge;
        const top = inset + (edge - barHeight) / 2;

        const cov = coverage(x, y, (px, py) =>
          insideRoundedRect(px, py, left, top, barWidth, barHeight, BAR_RADIUS * edge),
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

  return encodePng(size, raw);
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

function encodePng(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO container ---------------------------------------------------------
// A single 256x256 entry holding the PNG verbatim, which Windows has accepted
// since Vista. 0 in the size byte means 256.

function encodeIco(png) {
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

  return Buffer.concat([header, entry, png]);
}

// --- ICNS container --------------------------------------------------------
//
// 'icns', total length, then one chunk per size: a four-character type, the
// chunk length including its own 8-byte header, and the image. macOS has
// accepted PNG data in these chunks since 10.7, which is what makes an .icns
// writable from a machine that has no `iconutil` - i.e. this one.
//
// Every size is listed twice where a retina type exists for it, because Finder
// picks the type that matches the display it is drawing on, not the closest
// pixel size it can find.

/** Rendered size -> the icns types that expect exactly those pixels. */
const ICNS_TYPES = {
  16: ['icp4'],
  32: ['icp5', 'ic11'],
  64: ['icp6', 'ic12'],
  128: ['ic07'],
  256: ['ic08', 'ic13'],
  512: ['ic09', 'ic14'],
  1024: ['ic10'],
};

function encodeIcns(pngBySize) {
  const chunks = [];

  for (const [size, types] of Object.entries(ICNS_TYPES)) {
    const png = pngBySize.get(Number(size));
    for (const type of types) {
      const header = Buffer.alloc(8);
      header.write(type, 0, 'ascii');
      header.writeUInt32BE(png.length + 8, 4);
      chunks.push(header, png);
    }
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);

  return Buffer.concat([header, body]);
}

// --- Write -----------------------------------------------------------------

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(dir, { recursive: true });

// Full-bleed, for Windows and as the generic source image. electron-builder
// rejects a PNG icon below 512x512, so this doubles as the fallback it accepts.
const square512 = renderPng(512, { radius: WINDOWS_RADIUS });
const square256 = renderPng(256, { radius: WINDOWS_RADIUS });

writeFileSync(path.join(dir, 'icon.png'), square512);
writeFileSync(path.join(dir, 'icon.ico'), encodeIco(square256));

// Inset squircle, for macOS.
const macSizes = Object.keys(ICNS_TYPES).map(Number);
const macPngs = new Map(
  macSizes.map((size) => [
    size,
    renderPng(size, { margin: MACOS_MARGIN, radius: MACOS_RADIUS }),
  ]),
);
const icns = encodeIcns(macPngs);
writeFileSync(path.join(dir, 'icon.icns'), icns);

console.log(
  `Wrote build/icon.png (512), build/icon.ico (256) and build/icon.icns ` +
    `(${macSizes.join(', ')}; ${(icns.length / 1024).toFixed(1)} KB)`,
);
