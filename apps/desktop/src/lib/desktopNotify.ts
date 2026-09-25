import appIcon from '../assets/icon.png';

/**
 * OS-level notifications for mentions and DMs.
 *
 * Built on the standard web Notification API rather than anything
 * Electron-specific, so this file works unchanged in the packaged app and in
 * a plain browser tab. Electron still has to be told to allow it - see
 * `installPermissionHandlers` in the main process - or `Notification.permission`
 * never leaves `'default'` and every call here quietly does nothing.
 */

export function desktopNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * `'denied'` here means a hard block only the browser's or the OS's own
 * settings can undo - the switch in this app cannot ask again once it has
 * been refused once. Read live rather than cached, since that is exactly the
 * kind of thing that changes outside the app and needs to be noticed the next
 * time the settings screen renders.
 */
export function desktopNotificationPermission(): NotificationPermission | 'unsupported' {
  return desktopNotificationsSupported() ? Notification.permission : 'unsupported';
}

/**
 * Asks once. A browser remembers the person's answer across launches;
 * Electron has no prompt to show at all - the main process already decided,
 * and this just reads that decision back.
 */
export async function requestDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (!desktopNotificationsSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * Shows one, if permission has actually been granted.
 *
 * Silently does nothing otherwise rather than throwing - a toast that cannot
 * be shown is not a reason to break the message that triggered it, and the
 * settings screen is where "why am I not getting these" gets answered, not
 * the console.
 */
export function showDesktopNotification(input: { title: string; body: string; onClick(): void }): void {
  if (!desktopNotificationsSupported() || Notification.permission !== 'granted') return;

  const notification = new Notification(input.title, { body: input.body, icon: appIcon });
  notification.onclick = () => {
    // Electron only: undoes `mainWindow.hide()`, which a renderer-side
    // `window.focus()` cannot do on its own. A no-op in a plain browser tab,
    // where focusing the tab is the platform's job, not ours.
    void window.chitchak?.focusWindow();
    window.focus();
    input.onClick();
    notification.close();
  };
}
