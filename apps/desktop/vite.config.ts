import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// @ts-expect-error - a build script, not part of the typechecked source
import { assertAssetsResolved } from './scripts/assert-assets-resolved.mjs';

export default defineConfig({
  plugins: [react(), assertAssetsResolved({ outDir: 'dist', base: './' })],
  // Electron loads the built renderer from the filesystem, where absolute
  // asset paths resolve against the drive root and 404. Relative paths work in
  // both the dev server and file://.
  base: './',
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
