import { build as viteBuild } from 'vite';
import { buildElectron } from './build-electron.mjs';

/** Production build: renderer bundle plus the Electron entry points. */
await viteBuild({ configFile: './vite.config.ts' });
await buildElectron({ minify: true });

console.log('Built renderer -> dist/, electron -> dist-electron/');
