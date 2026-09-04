import { app, ipcMain, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';

/**
 * Automatic updates.
 *
 * Where the build goes: `npm run release` uploads the installer, its blockmap
 * and a `latest.yml` manifest to https://api.chitchak.com/updates. The version
 * in that manifest is the only thing that decides whether an update exists, so
 * publishing is entirely a matter of copying files - there is no update server
 * to run or keep alive.
 *
 * The rule this is built around: an update must never interrupt a call. So the
 * download happens quietly in the background, and installing is either the
 * user's explicit choice or something that happens on quit, when by definition
 * nobody is talking. The app is never restarted out from under anyone.
 */

// electron-updater is CommonJS with a default export, so it cannot be
// destructured in an import statement under Node's ESM interop rules.
const { autoUpdater } = electronUpdater;

/** Mirrors what the renderer needs to show. */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };

let state: UpdateState = { phase: 'idle' };
let getWindow: () => BrowserWindow | null = () => null;

function setState(next: UpdateState): void {
  state = next;
  getWindow()?.webContents.send('update:state', state);
}

/** How often a running app looks for a new version. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function initUpdater(resolveWindow: () => BrowserWindow | null): void {
  getWindow = resolveWindow;

  // The renderer mounts after the first events may already have fired, so it
  // asks for the current state rather than relying on catching them live.
  ipcMain.handle('update:state', () => state);

  ipcMain.handle('update:install', () => {
    if (state.phase !== 'ready') return { ok: false };
    // Silent: the assisted installer's wizard is right for a first install and
    // wrong for an update the person already agreed to. Force-run: put them
    // back where they were instead of leaving a closed app behind.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true };
  });

  // Development runs from source with no packaged version to compare against,
  // and electron-updater throws rather than no-opping.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  // The quiet path: someone who never touches the banner still gets the update
  // applied when they close the app, so the next launch is current.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => {
    // Only surfaced when there is nothing else to say, so a routine background
    // check does not replace a "ready to install" banner.
    if (state.phase === 'idle' || state.phase === 'error') setState({ phase: 'checking' });
  });

  autoUpdater.on('update-not-available', () => {
    if (state.phase === 'checking') setState({ phase: 'idle' });
  });

  // Carried from 'update-available' because the progress event reports bytes
  // only, and `currentVersion` is the version already installed, not the one
  // being fetched.
  let incoming = '';
  autoUpdater.on('update-available', (info) => {
    incoming = info.version;
  });

  autoUpdater.on('download-progress', (progress) => {
    setState({ phase: 'downloading', version: incoming, percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setState({ phase: 'ready', version: info.version });
  });

  autoUpdater.on('error', (error) => {
    // Being offline, or the update host being down, is not worth interrupting
    // anyone over - the app works fine either way. Recorded, shown only if the
    // renderer asks, and retried on the next interval.
    setState({ phase: 'error', message: error?.message ?? 'Update check failed' });
  });

  const check = () => {
    // A pending install is final; checking again would only download it twice.
    if (state.phase === 'ready') return;
    void autoUpdater.checkForUpdates().catch(() => {
      /* Reported through the 'error' event above. */
    });
  };

  // Not immediately on launch: the first seconds are spent connecting to the
  // gateway and joining channels, and a 90 MB download alongside that makes the
  // app feel slow for no reason.
  setTimeout(check, 15_000);
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  app.on('will-quit', () => clearInterval(timer));
}
