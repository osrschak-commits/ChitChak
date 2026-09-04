import path from 'node:path';
import { BrowserWindow, app, desktopCapturer, globalShortcut, ipcMain, shell } from 'electron';
import { initUpdater } from './updater.js';

/**
 * Electron main process.
 *
 * Holds no application state. Its jobs are the two things a browser tab cannot
 * do: own a real window, and observe key presses while the app is not focused.
 */

const isDev = !app.isPackaged;

// Remote debugging in development only. Lets the renderer be inspected and
// driven from outside the window - the difference between diagnosing a
// UI-triggered bug and guessing at it. Must be set before the app is ready,
// and is never enabled in a packaged build.
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
// This file is bundled to CommonJS (dist-electron/main.cjs), so __dirname is
// available. Electron's ESM support is still awkward around preload scripts,
// which must be CJS anyway.
const dirname = __dirname;

let mainWindow: BrowserWindow | null = null;

/**
 * Push-to-talk key. Electron's globalShortcut fires on key *press* only - there
 * is no key-release event - so a held-key PTT cannot be implemented with it.
 *
 * The compromise: while the window is focused the renderer listens for real
 * keydown/keyup and gets true hold-to-talk; while it is not focused, this
 * shortcut toggles transmission on and off. Proper global hold-to-talk needs a
 * native OS hook (uiohook-napi or similar) - see README.
 */
let pushToTalkAccelerator = 'F8';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#1a1b20',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(dirname, 'preload.cjs'),
      // The renderer runs untrusted-ish content (message text, display names).
      // Isolation plus no node integration means a rendering bug cannot reach
      // the filesystem or spawn processes.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  // Avoid the white flash before React paints.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Any attempt to open an external URL goes to the real browser, never into a
  // new Electron window with our privileges.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  /**
   * Keep the window on our own page, and send anything else to the browser.
   *
   * The earlier version of this allowed only the dev-server URL, which in a
   * packaged build meant *everything* was blocked - including the app
   * reloading itself. That is not a navigation to somewhere else, so it must
   * be allowed, or actions that refresh the app silently do nothing.
   */
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? '';

    let sameDocument = false;
    try {
      const target = new URL(url);
      const here = new URL(current);
      // file:// has a null origin, so compare protocol and path instead.
      sameDocument =
        target.protocol === here.protocol &&
        target.host === here.host &&
        target.pathname === here.pathname;
    } catch {
      sameDocument = false;
    }

    if (sameDocument) return;

    event.preventDefault();
    // Only hand real web links to the browser. Refusing anything else avoids
    // asking the OS to open an arbitrary scheme on our behalf.
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
  });

  if (isDev) {
    // Mirror the renderer's console into the terminal. Without this, diagnosing
    // anything that happens inside the renderer means having DevTools open and
    // watching at the right moment - useless for a failure someone reports
    // after the fact.
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const tag = ['debug', 'info', 'warn', 'error'][level] ?? 'log';
      const where = sourceId ? ` (${sourceId.split('/').pop()}:${line})` : '';
      console.log(`[renderer:${tag}]${where} ${message}`);
    });

    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(dirname, '../dist/index.html'));
  }
}

function registerPushToTalk(accelerator: string): boolean {
  globalShortcut.unregisterAll();
  try {
    return globalShortcut.register(accelerator, () => {
      // Only meaningful when unfocused; a focused window handles its own
      // keydown/keyup and would otherwise see the key twice.
      if (mainWindow?.isFocused()) return;
      mainWindow?.webContents.send('ptt:toggle');
    });
  } catch {
    return false;
  }
}

/**
 * The screen or window the renderer picked, held between its choice and the
 * `getDisplayMedia()` call that follows.
 */
let pendingScreenSourceId: string | null = null;
/**
 * Whether the pending share should carry the computer's sound.
 *
 * Off unless asked for. Loopback capture takes *everything* playing on the
 * machine, not just the window being shared, so doing it by default means
 * people broadcast their music, notifications and other calls without
 * realising.
 */
let pendingScreenAudio = false;

/**
 * Microphone and screen-capture permissions.
 *
 * `setDisplayMediaRequestHandler` is not optional: without it Electron rejects
 * every `getDisplayMedia()` call outright, so screen sharing fails before any
 * picker appears. Electron also has no built-in source chooser, so the renderer
 * asks for the source list, shows its own picker, and records the choice here
 * for this handler to return.
 */
function installPermissionHandlers(): void {
  const session = mainWindow?.webContents.session;
  if (!session) return;

  /**
   * Chromium routes several distinct capabilities through this one handler, and
   * denying by default means denying things the app needs:
   *
   *   media          - microphone and camera
   *   display-capture - the screen-share prompt
   *   fullscreen     - element.requestFullscreen()
   *
   * That last one is not obvious. Without it `requestFullscreen()` neither
   * resolves nor rejects; it simply hangs, and fullscreen silently does
   * nothing. Everything else - geolocation, notifications, MIDI, clipboard
   * reads - stays denied.
   */
  const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'fullscreen']);

  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  // Some of these arrive as synchronous checks rather than requests, and the
  // default there is also deny.
  session.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );

  session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!pendingScreenSourceId) {
        // Nothing chosen means the picker was dismissed. An empty callback is
        // how Electron expresses "cancelled", and surfaces as NotAllowedError.
        callback({});
        return;
      }

      const sourceId = pendingScreenSourceId;
      const withAudio = pendingScreenAudio;
      pendingScreenSourceId = null;
      pendingScreenAudio = false;

      void desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        const chosen = sources.find((source) => source.id === sourceId);
        if (!chosen) {
          callback({});
          return;
        }
        // 'loopback' captures system audio on Windows, and is ignored
        // elsewhere. Only requested when the person ticked the box.
        callback(withAudio ? { video: chosen, audio: 'loopback' } : { video: chosen });
      });
    },
    // We resolve the source ourselves rather than letting Chromium prompt.
    { useSystemPicker: false },
  );
}

app.whenReady().then(() => {
  createWindow();
  installPermissionHandlers();
  registerPushToTalk(pushToTalkAccelerator);
  initUpdater(() => mainWindow);

  /**
   * Screens and windows available to share, with preview thumbnails.
   *
   * Thumbnails come back as data URLs so the renderer can show them directly;
   * they are small, and the alternative is a second IPC round trip per source.
   */
  ipcMain.handle('screen:list-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
    }));
  });

  /** Records the choice for the getDisplayMedia call the renderer makes next. */
  ipcMain.handle(
    'screen:select-source',
    (_event, sourceId: string | null, withAudio: boolean = false) => {
      pendingScreenSourceId = sourceId;
      pendingScreenAudio = Boolean(withAudio);
      return { ok: true };
    },
  );

  ipcMain.handle('ptt:set-key', (_event, accelerator: string) => {
    const ok = registerPushToTalk(accelerator);
    if (ok) pushToTalkAccelerator = accelerator;
    // Fall back to the previous binding rather than leaving the user with none.
    if (!ok) registerPushToTalk(pushToTalkAccelerator);
    return { ok, accelerator: pushToTalkAccelerator };
  });

  ipcMain.handle('ptt:get-key', () => pushToTalkAccelerator);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
