#!/usr/bin/env node
/**
 * Serves the site locally, laid out the way the container lays it out.
 *
 *   npm run preview -w @chitchak/site      # http://localhost:4321
 *
 * The point is that the four things the page pulls together live in four
 * different places in the repo, and only the built image puts them in one
 * directory. This does the same mapping without Docker, so the page can be
 * looked at without a deploy:
 *
 *   /            public/                    the page itself
 *   /fonts/      node_modules/@fontsource*  the same webfonts the app bundles
 *   /app/        apps/desktop/dist-web      the web client, if it is built
 *   /download/   updates/                   published installers, if any exist
 *
 * Written on node:http with no dependencies, because a static file server is
 * forty lines and a dev-server dependency is a thing to keep current.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(here, '..');
const repo = path.join(site, '..', '..');

const PORT = Number(process.env.PORT ?? 4321);

/** Longest prefix wins, so /download does not get eaten by /. */
const MOUNTS = [
  ['/fonts/@fontsource-variable/', path.join(repo, 'node_modules', '@fontsource-variable')],
  ['/app/', path.join(repo, 'apps', 'desktop', 'dist-web')],
  ['/download/', path.join(repo, 'updates')],
  ['/fonts/', null], // resolved specially below
  ['/', path.join(site, 'public')],
];

/**
 * The webfonts are copied out of two packages with different layouts, and the
 * container flattens them into /fonts. Same flattening here.
 */
const FONTS = {
  'archivo-latin-wght-normal.woff2': path.join(
    repo,
    'node_modules',
    '@fontsource-variable',
    'archivo',
    'files',
    'archivo-latin-wght-normal.woff2',
  ),
  'ibm-plex-mono-latin-400-normal.woff2': path.join(
    repo,
    'node_modules',
    '@fontsource',
    'ibm-plex-mono',
    'files',
    'ibm-plex-mono-latin-400-normal.woff2',
  ),
  'ibm-plex-mono-latin-500-normal.woff2': path.join(
    repo,
    'node_modules',
    '@fontsource',
    'ibm-plex-mono',
    'files',
    'ibm-plex-mono-latin-500-normal.woff2',
  ),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.yml': 'text/yaml; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.map': 'application/json',
};

function resolve(urlPath) {
  if (urlPath.startsWith('/fonts/') && !urlPath.startsWith('/fonts/@')) {
    return FONTS[urlPath.slice('/fonts/'.length)] ?? null;
  }

  for (const [prefix, root] of MOUNTS) {
    if (root === null || !urlPath.startsWith(prefix)) continue;

    const relative = urlPath.slice(prefix.length);
    // Refuse anything that climbs out of the mount. This only ever serves a
    // developer's own machine, but a path traversal is not worth leaving in
    // even so.
    const full = path.join(root, relative);
    if (!full.startsWith(root)) return null;

    if (existsSync(full) && statSync(full).isDirectory()) {
      const index = path.join(full, 'index.html');
      return existsSync(index) ? index : null;
    }
    if (existsSync(full)) return full;
  }
  return null;
}

const server = createServer((request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const file = resolve(urlPath === '/' ? '/index.html' : urlPath);

  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`404 ${urlPath}\n`);
    return;
  }

  response.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
});

server.listen(PORT, () => {
  console.log(`\n  chitchak.com preview   http://localhost:${PORT}\n`);

  const app = path.join(repo, 'apps', 'desktop', 'dist-web');
  if (existsSync(app)) {
    // Worth saying plainly, because it looks exactly like a bug: the copy under
    // /app was built against the production API, whose CORS allowlist contains
    // the real site and nothing else. Signing in from localhost is refused by
    // design. Use `npm run dev:desktop` to actually work on the client.
    console.log('  /app      renders, but cannot sign in - it is built against the live API,');
    console.log('            which refuses this origin. `npm run dev:desktop` for real work.');
  } else {
    console.log('  /app      not built yet - `npm run build:web`');
  }

  if (!existsSync(path.join(repo, 'updates'))) {
    console.log('  /download no local updates/ directory - the page falls back to static links');
  }
  console.log();
});
