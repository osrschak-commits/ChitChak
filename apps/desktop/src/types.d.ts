import type { ChitChakBridge } from '../electron/preload.js';

declare global {
  interface Window {
    /**
     * Injected by the Electron preload script. Absent when the renderer is
     * loaded in a plain browser, which is why every use is guarded.
     */
    chitchak?: ChitChakBridge;
  }
}

export {};
