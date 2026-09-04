import { contextBridge, ipcRenderer } from 'electron';

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
   * Records which source to share. Must be called before starting the share:
   * Electron asks the main process which source to hand over, and this is the
   * answer it gives. Pass null to cancel.
   */
  selectScreenSource(sourceId: string | null): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('screen:select-source', sourceId);
  },
};

contextBridge.exposeInMainWorld('chitchak', api);

export type ChitChakBridge = typeof api;
