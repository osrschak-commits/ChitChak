import path from 'node:path';
import {
  BrowserWindow,
  app,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeTheme,
  shell,
  systemPreferences,
} from 'electron';
import { initUpdater } from './updater.js';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

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
 *
 * The default differs by platform because F8 is not a free key on a Mac: unless
 * "Use F1, F2 etc. as standard function keys" is turned on - and it is off by
 * default - the OS consumes it as Play/Pause before any app sees it, so the
 * binding registers successfully and then never fires. Option+Space is unbound
 * on macOS and reachable without contorting a hand.
 */
let pushToTalkAccelerator = isMac ? 'Alt+Space' : 'F8';

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

  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }

    // On Windows and Linux, saying yes here is the whole of it. macOS has a
    // second gate underneath - TCC - and Chromium does not open it for us: a
    // getUserMedia call with no OS-level grant fails with a bare NotAllowedError
    // and no prompt, which looks exactly like a broken microphone. Ask the
    // system here, at the moment the app actually wants the device, rather than
    // ambushing someone with two permission dialogs on first launch.
    if (!isMac || permission !== 'media') {
      callback(true);
      return;
    }

    // Chromium does not always say which devices it wants. Treating an unstated
    // request as a microphone one matches what this app asks for nearly every
    // time, and asking for a permission that turns out not to be needed is a
    // dialog too many, not a failure.
    const requested = (details as { mediaTypes?: Array<'audio' | 'video'> }).mediaTypes ?? [];
    const mediaTypes = requested.length > 0 ? requested : (['audio'] as const);

    const devices = mediaTypes.map((type) =>
      type === 'audio' ? ('microphone' as const) : ('camera' as const),
    );

    void (async () => {
      for (const device of devices) {
        if (systemPreferences.getMediaAccessStatus(device) === 'granted') continue;
        // Resolves false when denied, and - the case worth knowing about - when
        // the person has denied it before, in which case macOS shows nothing at
        // all and only a trip to System Settings can undo it.
        if (!(await systemPreferences.askForMediaAccess(device))) {
          callback(false);
          return;
        }
      }
      callback(true);
    })();
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
        // 'loopback' captures system audio, and Windows is the only platform
        // where Chromium implements it. macOS has no system-audio tap without a
        // kernel extension or a virtual device like BlackHole, so asking for it
        // there does not degrade to silence - the whole capture fails. Only
        // requested when the person ticked the box, and only where it works.
        const loopback = withAudio && isWindows;
        callback(loopback ? { video: chosen, audio: 'loopback' } : { video: chosen });
      });
    },
    // We resolve the source ourselves rather than letting Chromium prompt.
    { useSystemPicker: false },
  );
}

app.whenReady().then(() => {
  // The UI is graphite and has no light variant. Left to follow the system, a
  // Mac in light mode frames it in a pale native title bar and hands it white
  // scrollbars and white save dialogs; saying "dark" once makes the chrome the
  // OS draws match the window it is drawing around.
  nativeTheme.themeSource = 'dark';

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

  /**
   * Whether macOS will let us see the screen at all.
   *
   * Screen Recording is the one permission macOS will not prompt for from
   * inside the app: `getSources()` simply returns the desktop picture and a
   * list of windows with no names, so the picker looks broken rather than
   * blocked. The renderer asks first and explains, instead of showing an empty
   * grid. Everywhere else this is always 'granted'.
   */
  ipcMain.handle('screen:access', () => {
    if (!isMac) return 'granted';
    return systemPreferences.getMediaAccessStatus('screen');
  });

  /**
   * Opens the Screen Recording pane of System Settings.
   *
   * The permission only takes effect on relaunch, which macOS says in its own
   * dialog - so nothing here tries to re-check it afterwards.
   */
  ipcMain.handle('screen:open-settings', () => {
    if (!isMac) return { ok: false };
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    return { ok: true };
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
