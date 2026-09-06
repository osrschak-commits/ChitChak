import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app, ipcMain, shell, type BrowserWindow } from 'electron';
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
 *
 * macOS is the exception, and not by choice. Squirrel.Mac - which is what
 * electron-updater drives there - checks that the update it downloaded carries
 * the same code signature as the app already running, and refuses the swap if
 * it cannot. This build has no Apple Developer ID, so that check can never
 * pass. Rather than quietly pulling 95 MB in order to fail at the last step,
 * macOS is told there is a new version and handed the download link. If a
 * certificate is ever bought, deleting the `isMac` branches below is the whole
 * of the change.
 */

// electron-updater is CommonJS with a default export, so it cannot be
// destructured in an import statement under Node's ESM interop rules.
const { autoUpdater } = electronUpdater;

const isMac = process.platform === 'darwin';

/** Mirrors what the renderer needs to show. */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** macOS only: a newer version exists and has to be installed by hand. */
  | { phase: 'available'; version: string; url: string | null }
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

/**
 * The download the macOS banner links to.
 *
 * The host is read out of `app-update.yml`, the manifest electron-builder
 * copies into the package from the `publish` block - so there is one place
 * where the update host is configured, not two that can drift apart. The file
 * is three lines of YAML; a regex is proportionate to reading one of them, and
 * avoids pulling a parser into the main process for it.
 *
 * The filename, on the other hand, does have to match `mac.artifactName` in
 * electron-builder.yml. Renaming the artifact there means changing it here.
 */
function macDownloadUrl(version: string): string | null {
  let base: string | null = null;
  try {
    const config = readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    base = /^url:\s*(\S+)/m.exec(config)?.[1] ?? null;
  } catch {
    // Nothing to link to. The banner still says a new version exists, which is
    // the part that matters - it is just not clickable.
    return null;
  }
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/ChitChak-${version}-${process.arch}.dmg`;
}

export function initUpdater(resolveWindow: () => BrowserWindow | null): void {
  getWindow = resolveWindow;

  // The renderer mounts after the first events may already have fired, so it
  // asks for the current state rather than relying on catching them live.
  ipcMain.handle('update:state', () => state);

  ipcMain.handle('update:install', () => {
    // On macOS "install" is "open the download in a browser". Same button, same
    // channel, because from the renderer's side it is the same intent.
    if (state.phase === 'available') {
      if (state.url) void shell.openExternal(state.url);
      return { ok: state.url !== null };
    }

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

  autoUpdater.autoDownload = !isMac;
  // The quiet path: someone who never touches the banner still gets the update
  // applied when they close the app, so the next launch is current. Not on
  // macOS, where the install cannot succeed and would only produce an error
  // dialog on quit.
  autoUpdater.autoInstallOnAppQuit = !isMac;

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
    if (isMac) {
      setState({ phase: 'available', version: info.version, url: macDownloadUrl(info.version) });
    }
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
    // The same goes for a macOS banner already showing the download - nothing
    // said thirty minutes later changes what the person has to do.
    if (state.phase === 'ready' || state.phase === 'available') return;
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
