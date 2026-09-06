import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The same renderer, built for a browser instead of Electron.
 *
 * There is no second copy of the app: `src/` is the client, and every use of
 * the Electron bridge in it is written as `window.chitchak?.…` precisely so
 * that it can also run without one. What the browser loses is the three things
 * a page genuinely cannot do - hold-to-talk while another window has focus, a
 * source picker with thumbnails, and updating itself - and each of those is
 * guarded at the point of use rather than behind a build flag.
 *
 * Only the packaging differs, and only in two ways:
 *
 *   - `base` is an absolute path, not './'. Electron loads the built files from
 *     file://, where an absolute path resolves against the drive root; a web
 *     server is the opposite case, and relative paths would break the moment
 *     the app were served from anywhere but its exact directory.
 *   - No sourcemaps. They are 3 MB and would put the whole client source on a
 *     public origin for no benefit to anyone but a reader of it.
 */
export default defineConfig({
  plugins: [react()],
  // Must match where the site serves it. See apps/site/Caddyfile.
  base: '/app/',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    sourcemap: false,
  },
});
