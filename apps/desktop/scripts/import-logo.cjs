/**
 * Turns a designed logo into every icon the app needs.
 *
 *   npx electron scripts/import-logo.cjs build/logo-source.png
 *
 * Run under Electron rather than Node, and not because of a preference:
 * resizing an arbitrary PNG means decoding one, and Electron already ships a
 * decoder in `nativeImage`. The alternative is an image library in the
 * dependency tree of a build step that runs once whenever the logo changes.
 *
 * It writes `icon.png`, `icon.ico` and `icon.icns`, which is what every other
 * part of the app reads - the window, the tray, the splash, the installer and
 * the site all take their icon from those three files, so a new logo is one
 * command rather than a hunt.
 *
 * The ICO and ICNS containers are written by hand. Both are simple: a small
 * table of contents and a run of PNGs. macOS has accepted PNG data inside
 * .icns since 10.7, which is what makes one writable from a machine with no
 * `iconutil` - i.e. a Windows one.
 */
const { writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

const source = path.resolve(process.argv[2] ?? 'build/logo-source.png');
const outDir = path.resolve(__dirname, '..', 'build');

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

/** Sizes Windows actually picks between, smallest first. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function encodeIco(pngBySize) {
  const sizes = ICO_SIZES.filter((size) => pngBySize.has(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);

  const entries = [];
  const images = [];
  // Directory entries come first, so every offset has to account for all of
  // them being written before any image data.
  let offset = 6 + sizes.length * 16;

  for (const size of sizes) {
    const png = pngBySize.get(size);
    const entry = Buffer.alloc(16);
    // 256 is written as 0: the field is one byte, and 256 does not fit.
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    images.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images]);
}

function encodeIcns(pngBySize) {
  const chunks = [];
  for (const [size, types] of Object.entries(ICNS_TYPES)) {
    const png = pngBySize.get(Number(size));
    if (!png) continue;
    for (const type of types) {
      const head = Buffer.alloc(8);
      head.write(type, 0, 'ascii');
      head.writeUInt32BE(png.length + 8, 4);
      chunks.push(head, png);
    }
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

app.whenReady().then(() => {
  if (!existsSync(source)) {
    console.error(`No logo at ${source}`);
    app.exit(1);
    return;
  }

  const original = nativeImage.createFromPath(source);
  if (original.isEmpty()) {
    console.error(`${source} is not an image Electron can read`);
    app.exit(1);
    return;
  }

  const { width, height } = original.getSize();
  console.log(`source: ${width}x${height}`);
  if (width !== height) {
    // Not fatal - the resize will squash it - but it is almost never intended,
    // and an icon that is subtly wrong on every surface is hard to notice and
    // annoying to trace.
    console.warn('warning: the source is not square, so every icon will be stretched');
  }

  const wanted = [...new Set([...ICO_SIZES, ...Object.keys(ICNS_TYPES).map(Number), 512])].sort(
    (a, b) => a - b,
  );

  const pngBySize = new Map(
    wanted.map((size) => [
      size,
      // 'best' rather than the default: these are scaled down a long way, and
      // the cheap filter leaves the small sizes visibly ragged.
      original.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    ]),
  );

  // electron-builder refuses a PNG icon below 512x512, so this doubles as the
  // fallback it accepts.
  writeFileSync(path.join(outDir, 'icon.png'), pngBySize.get(512));
  writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(pngBySize));
  writeFileSync(path.join(outDir, 'icon.icns'), encodeIcns(pngBySize));

  console.log(`wrote icon.png (512), icon.ico (${ICO_SIZES.join(', ')}), icon.icns`);
  app.exit(0);
});
