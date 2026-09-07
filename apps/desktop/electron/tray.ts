import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Menu, Notification, Tray, app, nativeImage } from 'electron';
import iconPng from '../build/icon.png';

/**
 * The tray icon, and closing the window without leaving the call.
 *
 * This exists because of what the app is. Closing the window of a text app
 * means you are done with it; closing the window of a call means nothing of the
 * sort - people minimise the window and keep talking for hours. Quitting on
 * close would hang up on whoever they were speaking to, which is why the X
 * hides instead.
 *
 * The icon is inlined rather than read from disk: `build/` is electron-builder's
 * resources directory and is not inside the packaged app, so a path to it works
 * in development and silently fails to produce a tray in a real install.
 */

const isMac = process.platform === 'darwin';

/**
 * Whether the "it is still running" notice has been shown before.
 *
 * A window that vanishes rather than closing is alarming exactly once, and
 * being told about it every time is worse than never being told. Kept in a file
 * beside the app's other state so it survives restarts - the whole point is
 * that it is said once, not once per launch.
 */
function hintFile(): string {
  return path.join(app.getPath('userData'), 'tray-hint.json');
}

function hintAlreadyShown(): boolean {
  try {
    return JSON.parse(readFileSync(hintFile(), 'utf8')).shown === true;
  } catch {
    return false;
  }
}

function rememberHintShown(): void {
  try {
    writeFileSync(hintFile(), JSON.stringify({ shown: true }));
  } catch {
    // Worst case it is said twice. Not worth failing a window close over.
  }
}

export interface TrayHandle {
  /** Say, once ever, that closing the window did not quit. */
  explainOnce(): void;
  destroy(): void;
}

export function createTray(actions: { show(): void; quit(): void }): TrayHandle {
  // 16px is what Windows asks for; letting it scale a 512px source produces a
  // soft icon next to everybody else's crisp ones.
  const icon = nativeImage.createFromDataURL(iconPng).resize({ width: 16, height: 16 });

  const tray = new Tray(icon);
  tray.setToolTip('ChitChak');

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open ChitChak', click: actions.show },
      { type: 'separator' },
      // Spelled out rather than "Quit", because from here it is the one action
      // that will drop a call, and the menu is the only place that says so.
      { label: 'Quit ChitChak', click: actions.quit },
    ]),
  );

  // A click on the icon is the obvious way back in on Windows. macOS reserves
  // it for the menu, which is what people there expect.
  if (!isMac) {
    tray.on('click', actions.show);
  }
  tray.on('double-click', actions.show);

  return {
    explainOnce() {
      if (hintAlreadyShown() || !Notification.isSupported()) return;
      rememberHintShown();
      new Notification({
        title: 'ChitChak is still running',
        body: 'It is in the system tray, so calls keep going. Quit it from there.',
        icon: nativeImage.createFromDataURL(iconPng),
      }).show();
    },
    destroy() {
      tray.destroy();
    },
  };
}
