import { spawn } from 'node:child_process';
import process from 'node:process';
import electron from 'electron';
import { createServer } from 'vite';
import { buildElectron } from './build-electron.mjs';

/**
 * Dev runner: Vite for the renderer (hot reload), esbuild for the Electron
 * entry points, then launch Electron once the dev server is actually listening.
 *
 * Starting Vite programmatically rather than racing `electron` against a
 * `wait-on` in a shell chain means the URL is known to be up before Electron
 * asks for it - no "connection refused" white window on a cold start.
 */

await buildElectron();

const server = await createServer({ configFile: './vite.config.ts' });
await server.listen();

const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173';
server.config.logger.info(`\n  renderer ready at ${url}\n`);

// VS Code's integrated terminal (and any Electron-hosted shell) exports
// ELECTRON_RUN_AS_NODE=1. Inherited, it makes our binary start as a bare Node
// process with no window and no error - so strip it rather than let `npm run
// dev` mysteriously do nothing depending on which terminal you used.
const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env;

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...cleanEnv, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
});

// Closing the app window should end the whole dev session, not leave an orphan
// Vite server holding port 5173 against the next run.
child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill());
}
