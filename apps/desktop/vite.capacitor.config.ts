import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// @ts-expect-error - a build script, not part of the typechecked source
import { assertAssetsResolved } from './scripts/assert-assets-resolved.mjs';

/**
 * The same renderer again, this time for Capacitor's webview.
 *
 * Everything vite.web.config.ts says about there being one client applies
 * here too - this is not a third copy of the app. The only reason this is
 * its own config rather than reusing the web one is `base`: the web build is
 * mounted under /app/ because apps/site serves other things beside it, but
 * Capacitor hands the whole origin to index.html, so a /app/ prefix would
 * send every asset reference looking for a path that does not exist in the
 * app bundle. No `--mode` flag either - `vite build` defaults to production
 * and loads .env.production the same way the web build does, so this talks
 * to the real API and SFU, not localhost.
 */
export default defineConfig({
  plugins: [react(), assertAssetsResolved({ outDir: 'dist-capacitor', base: '/' })],
  base: '/',
  build: {
    outDir: 'dist-capacitor',
    emptyOutDir: true,
    sourcemap: false,
  },
});
