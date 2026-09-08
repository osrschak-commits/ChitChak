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
const { writeFileSync, existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const electron = require('electron');

/**
 * Start again, properly, if we are not actually in Electron.
 *
 * `require('electron')` returns the module inside Electron and the *path to the
 * Electron binary* outside it - which is what happens under plain `node`, and
 * also under `electron` itself when ELECTRON_RUN_AS_NODE is set, as several
 * editors and task runners do to their child processes. Both cases used to end
 * at "Cannot read properties of undefined (reading 'whenReady')", which says
 * nothing about the cause.
 *
 * The string we were handed is the binary, so re-exec it with the flag cleared.
 */
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
  process.exit(run.status ?? 1);
}

const { app, nativeImage } = electron;

const source = path.resolve(process.argv[2] ?? 'build/logo-source.png');
const outDir = path.resolve(__dirname, '..', 'build');

/**
 * The website's copy, written here rather than in the site's own build.
 *
 * The site is static files served by Caddy - there is no build step to hang
 * this off, and the alternative is remembering to copy a file across whenever
 * the logo changes. A forgotten copy means the site quietly keeps the old mark,
 * which is exactly the sort of thing nobody notices for a month.
 *
 * Skipped without complaint if the site is not checked out beside us.
 */
const siteIcon = path.resolve(__dirname, '..', '..', 'site', 'public', 'icon.png');

/**
 * The renderer's copy, which is committed rather than generated.
 *
 * Everything else in build/ is gitignored, because it is rebuilt from the logo
 * on the machine that packages the app. The renderer cannot rely on that: it is
 * also built inside apps/site/Dockerfile, from a checkout, with no Electron to
 * run the importer - so a build/ path resolves to nothing there.
 *
 * Vite does not fail on a missing asset in HTML or CSS. It leaves the URL
 * untouched, emits nothing, and exits zero, so the first sign is a 404 in
 * somebody's browser. Committing this one file is what keeps the web client's
 * favicon and sign-in logo from depending on a step that cannot run.
 */
const rendererIcon = path.resolve(__dirname, '..', 'src', 'assets', 'icon.png');

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

/**
 * How much of each edge is left clear, as a fraction of the icon's width.
 *
 * The source art is trimmed to the mark and re-padded to this, rather than
 * used as drawn. A logo exported for a website is usually generous with
 * whitespace, and an icon is the one place that reads as a mistake: every
 * icon beside it in a taskbar or a dock is drawn to fill its square, so
 * padding shows up as *this app's* icon being small and faint rather than as
 * breathing room. Seven percent is roughly what the platform icons use.
 */
const MARGIN = 0.07;

/**
 * The tight box around everything that is not transparent.
 *
 * The threshold is not zero: exported art tends to carry a halo of nearly
 * transparent pixels around the edge, and treating those as content puts the
 * padding straight back.
 */
function opaqueBounds(image) {
  const { width, height } = image.getSize();
  const px = image.getBitmap();
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * The mark, scaled to fit and centred on a transparent square.
 *
 * Scaled from the trimmed original at every size rather than from one padded
 * copy - resizing twice is how small icons end up soft, and the small ones are
 * the sizes anybody actually looks at.
 *
 * The aspect ratio is kept, so a mark that is not square is centred rather
 * than stretched. Composing by hand because `nativeImage` can resize and crop
 * but not place one image on another; a transparent buffer with the pixels
 * copied into the middle of it is the whole operation.
 */
function square(mark, size) {
  const inner = Math.max(1, Math.round(size * (1 - 2 * MARGIN)));
  const source = mark.getSize();
  const scale = inner / Math.max(source.width, source.height);

  const resized = mark.resize({
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
    // 'best' rather than the default: these are scaled a long way, and the
    // cheap filter leaves the small sizes visibly ragged.
    quality: 'best',
  });

  const { width, height } = resized.getSize();
  const pixels = resized.getBitmap();
  const canvas = Buffer.alloc(size * size * 4); // zeroed, so transparent
  const left = Math.round((size - width) / 2);
  const top = Math.round((size - height) / 2);

  for (let y = 0; y < height; y++) {
    pixels.copy(canvas, ((top + y) * size + left) * 4, y * width * 4, (y + 1) * width * 4);
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size }).toPNG();
}

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
  const bounds = opaqueBounds(original);
  if (!bounds) {
    console.error(`${source} is entirely transparent`);
    app.exit(1);
    return;
  }

  console.log(`source: ${width}x${height}, mark: ${bounds.width}x${bounds.height}`);

  // Worth saying out loud. Trimming is right far more often than not, but it
  // does mean the icons are not pixel-for-pixel what the designer exported,
  // and that is a surprise best had here rather than in a shipped installer.
  const fill = Math.round((100 * Math.max(bounds.width, bounds.height)) / Math.max(width, height));
  if (fill < 95) {
    console.log(`trimmed ${100 - fill}% padding, re-padded to ${Math.round(MARGIN * 100)}% a side`);
  }

  const mark = original.crop(bounds);

  const wanted = [...new Set([...ICO_SIZES, ...Object.keys(ICNS_TYPES).map(Number), 512])].sort(
    (a, b) => a - b,
  );

  const pngBySize = new Map(wanted.map((size) => [size, square(mark, size)]));

  // electron-builder refuses a PNG icon below 512x512, so this doubles as the
  // fallback it accepts.
  writeFileSync(path.join(outDir, 'icon.png'), pngBySize.get(512));
  writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(pngBySize));
  writeFileSync(path.join(outDir, 'icon.icns'), encodeIcns(pngBySize));

  console.log(`wrote icon.png (512), icon.ico (${ICO_SIZES.join(', ')}), icon.icns`);

  // 256 rather than 512: it is a favicon and a 26px header mark, and the site
  // is the one place where the bytes are on somebody else's connection.
  if (existsSync(path.dirname(siteIcon))) {
    writeFileSync(siteIcon, pngBySize.get(256));
    console.log('wrote the site icon (256)');
  }

  mkdirSync(path.dirname(rendererIcon), { recursive: true });
  writeFileSync(rendererIcon, pngBySize.get(256));
  console.log('wrote the renderer icon (256) - commit this one');

  app.exit(0);
});
