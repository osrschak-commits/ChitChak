/**
 * Fills in the download links from the update manifests.
 *
 * The page ships with no version number in it. `latest.yml` and
 * `latest-mac.yml` are already published on every release - they are what the
 * desktop app reads to notice a new build - so the site reads the same two
 * files rather than being rebuilt and redeployed every time a version ships.
 *
 * Everything here is an enhancement. With the script blocked, failed, or simply
 * slow, every row is already a working link to /download/ and the hero button
 * already scrolls to the table. Nothing below may leave the page worse than it
 * found it.
 */

const MANIFESTS = {
  win: '/download/latest.yml',
  mac: '/download/latest-mac.yml',
};

/**
 * Reads the handful of fields we need out of an electron-builder manifest.
 *
 * A regex rather than a YAML parser: these files are generated, not written,
 * and their shape is a flat `version` plus a list of `- url:` entries each
 * followed by its `size`. Pulling in a parser to read three keys would be more
 * code shipped to every visitor than the whole rest of this file.
 */
function parseManifest(text) {
  const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;

  const files = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();

    const url = /^-\s*url:\s*(.+)$/.exec(line);
    if (url) {
      current = { url: url[1].trim().replace(/^['"]|['"]$/g, ''), size: null };
      files.push(current);
      continue;
    }

    const size = /^size:\s*(\d+)$/.exec(line);
    if (size && current) current.size = Number(size[1]);
  }

  return { version, files };
}

async function loadManifest(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return parseManifest(await response.text());
  } catch {
    // Offline, or the updates directory is not there yet. The static links
    // stand.
    return null;
  }
}

function formatSize(bytes) {
  if (!bytes) return null;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Which build this visitor wants.
 *
 * The architecture question only exists on macOS, and no browser answers it
 * directly. Chromium-based ones will say if asked through client hints; Safari
 * will not, so the fallback reads the WebGL renderer, which is "Apple GPU" on
 * Apple Silicon and an Intel or AMD part otherwise. If both fail, arm64 is the
 * better guess - every Mac sold since late 2020 is one - and the Intel row is
 * still right there.
 */
async function detectPlatform() {
  const ua = navigator.userAgent;

  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/Android|iPhone|iPod/i.test(ua) || /iPad/.test(ua) || touchMac) return 'mobile';

  if (/Windows/.test(ua)) return 'win';
  if (!/Mac/.test(ua)) return null;

  return (await isAppleSilicon()) ? 'mac-arm64' : 'mac-x64';
}

async function isAppleSilicon() {
  try {
    const hints = await navigator.userAgentData?.getHighEntropyValues(['architecture']);
    if (hints?.architecture) return hints.architecture === 'arm';
  } catch {
    /* Not supported here; fall through to the renderer check. */
  }

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    if (renderer) return /apple/i.test(renderer);
  } catch {
    /* Blocked by a privacy setting, most likely. */
  }

  return true;
}

const LABELS = {
  win: 'Download for Windows',
  'mac-arm64': 'Download for Mac',
  'mac-x64': 'Download for Mac',
};

function applyRow(platform, file, version) {
  const row = document.querySelector(`.dl[data-platform="${platform}"]`);
  if (!row || !file) return null;

  const href = `/download/${encodeURIComponent(file.url)}`;
  const link = row.querySelector('[data-role="link"]');
  if (link) {
    link.href = href;
    link.setAttribute('download', '');
  }

  const meta = row.querySelector('[data-role="meta"]');
  const size = formatSize(file.size);
  if (meta && size) meta.textContent = `${meta.textContent} · ${size}`;

  return { href, size, version };
}

async function main() {
  const [win, mac] = await Promise.all([loadManifest(MANIFESTS.win), loadManifest(MANIFESTS.mac)]);

  const resolved = {
    win: applyRow('win', win?.files.find((f) => f.url.endsWith('.exe')), win?.version),
    // The .dmg, not the .zip. Both are published because electron-updater
    // installs from the zip, but a person downloading by hand wants the disk
    // image.
    'mac-arm64': applyRow(
      'mac-arm64',
      mac?.files.find((f) => f.url.includes('arm64') && f.url.endsWith('.dmg')),
      mac?.version,
    ),
    'mac-x64': applyRow(
      'mac-x64',
      mac?.files.find((f) => f.url.includes('x64') && f.url.endsWith('.dmg')),
      mac?.version,
    ),
  };

  // The desktop app's version, which is the one worth showing. If only one
  // platform has ever been published, that is the number.
  const version = win?.version ?? mac?.version;
  if (version) {
    const line = document.getElementById('version-line');
    if (line) line.textContent = `v${version}`;
  }

  const platform = await detectPlatform();

  if (platform === 'mobile') {
    document.getElementById('mobile-note')?.removeAttribute('hidden');
    // Nothing on this page is downloadable from a phone, so the hero button
    // becomes the one thing that does work there.
    const button = document.getElementById('primary-download');
    const label = document.getElementById('primary-label');
    if (button && label) {
      button.href = '/app';
      label.textContent = 'Open in browser';
    }
    // Otherwise the hero offers the same thing twice: the primary button has
    // just become "open in browser", and the secondary already was.
    document.getElementById('secondary-cta')?.setAttribute('hidden', '');

    const note = document.getElementById('primary-note');
    if (note) note.textContent = 'The desktop app is Windows and macOS for now.';
    return;
  }

  if (!platform) return;

  document.querySelector(`.dl[data-platform="${platform}"]`)?.classList.add('dl--yours');

  const target = resolved[platform];
  if (!target) return;

  const button = document.getElementById('primary-download');
  const label = document.getElementById('primary-label');
  if (button && label) {
    button.href = target.href;
    button.setAttribute('download', '');
    label.textContent = LABELS[platform];
  }

  const note = document.getElementById('primary-note');
  if (note && target.version) {
    const size = target.size ? `${target.size} · ` : '';
    const arch = platform === 'mac-x64' ? ' · Intel' : platform === 'mac-arm64' ? ' · Apple Silicon' : '';
    note.textContent = `${size}v${target.version}${arch}. You will need an invite code from whoever runs your server.`;
  }
}

void main();
