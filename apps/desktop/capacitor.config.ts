import type { CapacitorConfig } from '@capacitor/cli';

/**
 * `webDir` points at the Capacitor build (vite.capacitor.config.ts), not
 * dist-web - that one is base: '/app/', built for apps/site to mount
 * alongside the marketing pages, and its asset paths do not resolve when
 * Capacitor serves index.html from the bundle root instead.
 *
 * `appId` is a placeholder pending an Apple Developer account - it can
 * still change right up until the app is first submitted, and `npx cap
 * sync` after editing it is enough to push a change through. It only needs
 * to be final at that point.
 */
const config: CapacitorConfig = {
  appId: 'com.chitchak.app',
  appName: 'ChitChak',
  webDir: 'dist-capacitor',
};

export default config;
