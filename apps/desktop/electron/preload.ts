import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateState } from './updater.js';

/**
 * The only bridge between the renderer and Node.
 *
 * Deliberately tiny and fully enumerated: the renderer gets these four
 * functions and nothing else. Exposing `ipcRenderer` itself would hand any
 * script in the page the ability to invoke every channel in the main process.
 */
const api = {
  platform: process.platform,

  /** Fires when the global push-to-talk key is pressed while unfocused. */
  onPushToTalkToggle(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('ptt:toggle', listener);
    return () => ipcRenderer.off('ptt:toggle', listener);
  },

  /** @returns whether the accelerator was accepted (it may already be taken). */
  setPushToTalkKey(accelerator: string): Promise<{ ok: boolean; accelerator: string }> {
    return ipcRenderer.invoke('ptt:set-key', accelerator);
  },

  getPushToTalkKey(): Promise<string> {
    return ipcRenderer.invoke('ptt:get-key');
  },

  /** Screens and windows that can be shared, with preview thumbnails. */
  listScreenSources(): Promise<
    Array<{ id: string; name: string; kind: 'screen' | 'window'; thumbnail: string | null }>
  > {
    return ipcRenderer.invoke('screen:list-sources');
  },

  /**
   * Whether the OS will let us capture the screen. Always 'granted' outside
   * macOS, which is the only platform that gates it - and gates it silently.
   */
  getScreenAccess(): Promise<'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'> {
    return ipcRenderer.invoke('screen:access');
  },

  /** Opens macOS's Screen Recording settings. No-op elsewhere. */
  openScreenSettings(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('screen:open-settings');
  },

  /**
   * Records which source to share. Must be called before starting the share:
   * Electron asks the main process which source to hand over, and this is the
   * answer it gives. Pass null to cancel.
   */
  selectScreenSource(sourceId: string | null, withAudio = false): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('screen:select-source', sourceId, withAudio);
  },

  /** Where the app is in the check/download/install cycle, right now. */
  getUpdateState(): Promise<UpdateState> {
    return ipcRenderer.invoke('update:state');
  },

  onUpdateState(handler: (state: UpdateState) => void): () => void {
    const listener = (_event: unknown, state: UpdateState) => handler(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.off('update:state', listener);
  },

  /** Quits, installs the downloaded update and reopens. */
  installUpdate(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('update:install');
  },
};

contextBridge.exposeInMainWorld('chitchak', api);

export type ChitChakBridge = typeof api;
