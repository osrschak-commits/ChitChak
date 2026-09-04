import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * Bundles the Electron main and preload scripts.
 *
 * CommonJS output: Electron's preload scripts must be CJS, and keeping main.cjs
 * in the same format avoids a mixed-module setup for two small files. `electron`
 * is external because it is provided by the runtime, not resolvable from disk.
 */
export async function buildElectron({ minify = false } = {}) {
  await build({
    entryPoints: {
      main: 'electron/main.ts',
      preload: 'electron/preload.ts',
    },
    outdir: 'dist-electron',
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: true,
    minify,
    logLevel: 'warning',
  });
}

// pathToFileURL rather than string concatenation: on Windows a path starts with
// a drive letter, so "file://" + "C:/..." produces file://C:/... where Node
// gives file:///C:/... - the comparison never matched and running this file
// directly did nothing at all, silently.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await buildElectron();
}
