/**
 * Crops each badge's viewBox to the artwork inside it.
 *
 *   npm run badges -w @chitchak/desktop
 *
 * Design tools export onto whatever canvas the document had, which is usually
 * square and usually mostly empty. A badge is drawn at 18px beside a name, so
 * empty canvas is not neutral - it is a straight division of the pixels the
 * artwork gets. The founder badge arrived 930x460 inside a 1024 square: 55% of
 * its height was nothing, and it rendered at half the size it could have.
 *
 * Only the `viewBox` attribute changes. Every path is left exactly as exported,
 * so this is reversible by re-exporting and re-running, and re-running on an
 * already-cropped file computes the same box again and does nothing.
 *
 * Runs under Electron because measuring the artwork means rendering it, and
 * Electron is already here for the same reason `import-logo.cjs` uses it.
 */
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const electron = require('electron');

// Re-exec properly if we are in Node mode. See import-logo.cjs for why.
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  process.exit(
    spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env }).status ?? 1,
  );
}

const { app, BrowserWindow, nativeImage } = electron;

const BADGES = path.resolve(__dirname, '..', 'src', 'assets', 'badges');

/** Big enough that a one-pixel error in the measurement is invisible. */
const MEASURE_AT = 1024;

/** Ignore near-transparent edge pixels, which exported art tends to carry. */
const ALPHA_FLOOR = 8;

/**
 * The artwork's bounds, in the file's own viewBox coordinates.
 *
 * Measured in viewBox units rather than pixels, which is what makes this safe
 * to run twice. An earlier version rendered every badge into a fixed square:
 * fine the first time, and wrong the second, because a cropped 2:1 badge forced
 * into a square is letterboxed - so it would measure the letterboxed art and
 * crop it again, a little more each run.
 *
 * Rendering at a fixed width with the height left to the image means the frame
 * always matches the artwork's shape, and the numbers map straight back.
 */
async function boundsOf(window, file, viewBox) {
  const [vbX, vbY, vbWidth, vbHeight] = viewBox.split(/[\s,]+/).map(Number);
  const renderedHeight = Math.max(1, Math.round((MEASURE_AT * vbHeight) / vbWidth));

  const page = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;background:transparent}img{display:block;width:${MEASURE_AT}px;height:auto}</style>
    <img src="${path.basename(file)}">`;

  // Written beside the badge so the relative src resolves, and as a file rather
  // than a data URL so the SVG is same-origin with the page.
  const scratch = path.join(BADGES, '.measure.html');
  writeFileSync(scratch, page);
  try {
    window.setContentSize(MEASURE_AT, renderedHeight);
    await window.loadFile(scratch);
    // A frame, so the image is decoded and painted before it is captured.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const shot = await window.webContents.capturePage();
    const { width, height } = shot.getSize();
    const pixels = shot.getBitmap(); // BGRA

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > ALPHA_FLOOR) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0) return null;

    const toX = (px) => vbX + (px / width) * vbWidth;
    const toY = (py) => vbY + (py / height) * vbHeight;

    const left = Math.floor(toX(minX));
    const top = Math.floor(toY(minY));
    return {
      x: left,
      y: top,
      width: Math.max(1, Math.ceil(toX(maxX + 1) - left)),
      height: Math.max(1, Math.ceil(toY(maxY + 1) - top)),
    };
  } finally {
    require('node:fs').rmSync(scratch, { force: true });
  }
}

app.whenReady().then(async () => {
  let files;
  try {
    files = readdirSync(BADGES).filter((name) => name.endsWith('.svg'));
  } catch {
    console.log('No badges directory yet - nothing to do.');
    app.exit(0);
    return;
  }

  if (files.length === 0) {
    console.log('No badges to crop.');
    app.exit(0);
    return;
  }

  const window = new BrowserWindow({
    show: false,
    width: MEASURE_AT,
    height: MEASURE_AT,
    // Transparent, so "has anything been drawn here" is a question the alpha
    // channel can answer.
    transparent: true,
    frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
  });
  window.setBackgroundColor('#00000000');

  for (const name of files) {
    const file = path.join(BADGES, name);
    const svg = readFileSync(file, 'utf8');

    const original = /viewBox="([^"]+)"/.exec(svg);
    if (!original) {
      console.warn(`  ${name}: no viewBox, skipped`);
      continue;
    }

    const box = await boundsOf(window, file, original[1]);
    if (!box) {
      console.warn(`  ${name}: nothing drawn in it, skipped`);
      continue;
    }

    const next = `${box.x} ${box.y} ${box.width} ${box.height}`;
    if (original[1] === next) {
      console.log(`  ${name}: already cropped (${next})`);
      continue;
    }

    /*
      Rewritten inside the <svg> element only, and its width and height go too.

      Left behind, those attributes keep forcing the old square shape: the
      viewBox says 930x460 while the box around it still says 1024x1024, so
      the crop is letterboxed straight back into a square and achieves
      nothing. Removed, the image takes its ratio from the viewBox, which is
      what lets the CSS set a height and leave the width to the artwork.

      Matched on the element rather than on the first ">" in the file - that
      one closes the XML declaration, which comes first and has no width to
      strip.
    */
    const tag = /<svg[^>]*>/.exec(svg);
    if (!tag) {
      console.warn(`  ${name}: no <svg> element, skipped`);
      continue;
    }
    const rewritten = tag[0]
      .replace(/viewBox="[^"]*"/, `viewBox="${next}"`)
      .replace(/\s(?:width|height)="[^"]*"/g, '');
    const cropped = svg.replace(tag[0], rewritten);

    writeFileSync(file, cropped);
    const ratio = (box.width / box.height).toFixed(2);
    console.log(`  ${name}: ${original[1]} -> ${next}  (${ratio}:1)`);
  }

  console.log(`\nCropped ${files.length} badge${files.length === 1 ? '' : 's'}.`);
  app.exit(0);
});
