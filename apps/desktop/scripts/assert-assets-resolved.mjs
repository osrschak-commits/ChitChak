import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Fails the build if an asset reference points at a file that was not emitted.
 *
 * Vite does not treat a missing file referenced from HTML or CSS as an error.
 * It leaves the URL exactly as written, emits nothing, and exits zero - so a
 * path that points at a file which does not exist in that build context ships
 * as a 404 in somebody's browser, with a clean build log behind it.
 *
 * That is precisely what happened when the renderer's favicon and sign-in logo
 * pointed into apps/desktop/build/, which `npm run logo` generates and git
 * ignores: correct on the machine that had run the importer, absent inside the
 * Docker build that produces the web client.
 *
 * The check is deliberately "does the file exist in the output", not "does the
 * URL look right". The first version of this asked whether the path contained
 * the assets directory, which both broken references did - `./src/assets/…` and
 * `./assets/…` - so it passed them both and caught nothing. What a URL looks
 * like is a guess; whether the bytes are on disk is the actual question.
 */
export function assertAssetsResolved({ outDir, base = '/' }) {
  /** Local URLs only - a remote one is somebody else's to serve. */
  const isLocal = (url) =>
    !/^[a-z]+:/i.test(url) && !url.startsWith('//') && !url.startsWith('#');

  const ASSET = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|css|js|mjs)$/i;

  return {
    name: 'chitchak:assert-assets-resolved',
    apply: 'build',
    closeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        const root = path.resolve(outDir);
        const missing = [];

        /** Where a URL in `fromFile` would land on this output tree. */
        const locate = (ref, fromFile) => {
          const clean = ref.split('?')[0].split('#')[0];
          if (clean.startsWith('/')) {
            // Absolute, so it is served from the site root. `base` is the
            // prefix the app is mounted under and is not part of the path on
            // disk.
            const withoutBase =
              base !== '/' && clean.startsWith(base) ? clean.slice(base.length) : clean.slice(1);
            return path.join(root, withoutBase);
          }
          return path.resolve(path.dirname(fromFile), clean);
        };

        const walk = (dir) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(full);
              continue;
            }
            if (!/\.(html|css)$/i.test(entry.name)) continue;

            const text = readFileSync(full, 'utf8');
            const refs = [
              ...[...text.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]),
              ...[...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]),
            ];

            for (const ref of refs) {
              if (!isLocal(ref)) continue;
              const clean = ref.split('?')[0].split('#')[0];
              if (!ASSET.test(clean)) continue;
              if (!existsSync(locate(ref, full))) {
                missing.push(`${path.relative(root, full)}  ->  ${ref}`);
              }
            }
          }
        };

        walk(root);

        if (missing.length > 0) {
          throw new Error(
            `Asset references with nothing behind them:\n\n  ${missing.join(
              '\n  ',
            )}\n\nVite leaves a URL alone when it cannot find the file, so these built ` +
              `cleanly and would 404 at runtime.\n`,
          );
        }
      },
    },
  };
}
