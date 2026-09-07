import { BrowserWindow, nativeImage } from 'electron';
import appIcon from '../build/icon.png';
import monoFont from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2';

/**
 * The window that stands in for the app while it gets ready.
 *
 * It exists for one honest reason: on a cold start there is a real wait before
 * anything can be shown - the update check, then Chromium, React, fonts and the
 * gateway handshake - and a person staring at nothing cannot tell a slow launch
 * from a broken one. This says which of the two it is.
 *
 * It is also where a boot-time update goes. Downloading 90 MB behind a window
 * that looks finished is how you get someone quitting mid-download, over and
 * over, and never actually updating.
 *
 * Written as a data URL rather than an HTML file so it cannot be affected by
 * how the renderer is bundled or where the packaged app puts its resources:
 * this is the window that says why nothing else has appeared yet, and it must
 * not be able to fail to load. The font is inlined for the same reason - a
 * splash that falls back to Times New Roman for a second is worse than no
 * splash at all.
 */

export type SplashPhase = 'starting' | 'checking' | 'downloading' | 'installing' | 'loading';

const PANEL = '#131215';
const BORDER = '#363340';
const BRASS = '#d9a45b';
const TRACK = '#232128';
const MUTED = '#6b6675';

const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'IBM Plex Mono';
    src: url(${monoFont}) format('woff2');
    font-weight: 600;
    font-display: block;
  }

  html, body {
    margin: 0;
    height: 100%;
    background: transparent;
    overflow: hidden;
    /* Nothing here is selectable or draggable-as-content; the whole panel is
       the window. */
    user-select: none;
    cursor: default;
  }

  .panel {
    box-sizing: border-box;
    height: 100%;
    background: ${PANEL};
    border: 1px solid ${BORDER};
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 26px 28px 22px;
    /* Lets the window be dragged by its background, which a frameless window
       otherwise cannot be. */
    -webkit-app-region: drag;
  }

  .mark {
    font-family: 'IBM Plex Mono', ui-monospace, Consolas, monospace;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.28em;
    color: ${BRASS};
  }

  .foot { display: flex; flex-direction: column; gap: 11px; }

  .status {
    font-family: 'IBM Plex Mono', ui-monospace, Consolas, monospace;
    font-size: 11px;
    color: ${MUTED};
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-variant-numeric: tabular-nums;
  }

  .track {
    position: relative;
    height: 3px;
    border-radius: 999px;
    background: ${TRACK};
    overflow: hidden;
  }

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 999px;
    background: ${BRASS};
    width: 0%;
    transition: width 220ms cubic-bezier(0.2, 0, 0, 1);
  }

  /* No percentage to show yet, so the bar says "working" instead of lying
     about how far along it is. */
  .track--waiting .fill {
    width: 32%;
    transition: none;
    animation: sweep 1150ms cubic-bezier(0.45, 0, 0.55, 1) infinite alternate;
  }

  /*
   * Travels edge to edge and back, never off the end.
   *
   * A sweep that runs off one side and reappears at the other spends part of
   * every cycle with an empty track, which on a slow update check is exactly
   * the moment it needs to look like something is still happening. 212.5% of
   * its own width is the remaining 68% of the track.
   */
  @keyframes sweep {
    from { transform: translateX(0); }
    to   { transform: translateX(212.5%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .track--waiting .fill { animation-duration: 2600ms; }
  }
</style>
</head>
<body>
  <div class="panel">
    <div class="mark">CHITCHAK</div>
    <div class="foot">
      <div class="status">
        <span id="say">Starting…</span>
        <span id="pct"></span>
      </div>
      <div class="track track--waiting" id="track"><div class="fill" id="fill"></div></div>
    </div>
  </div>
  <script>
    window.__splash = (phase, percent) => {
      const say = {
        starting: 'Starting…',
        checking: 'Checking for updates…',
        downloading: 'Downloading update',
        installing: 'Installing update…',
        loading: 'Almost there…',
      }[phase] ?? 'Starting…';

      document.getElementById('say').textContent = say;

      const known = phase === 'downloading' && typeof percent === 'number';
      document.getElementById('pct').textContent = known ? percent + '%' : '';
      document.getElementById('track').classList.toggle('track--waiting', !known);
      if (known) document.getElementById('fill').style.width = percent + '%';
    };
  </script>
</body>
</html>`;

export interface Splash {
  /** Say what is happening. `percent` only means anything while downloading. */
  set(phase: SplashPhase, percent?: number): void;
  close(): void;
  window: BrowserWindow;
}

export function createSplash(): Splash {
  const window = new BrowserWindow({
    width: 400,
    height: 190,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    // Above other windows while it is the only thing the app has to show, but
    // released before the real window opens - see `close`. A splash that
    // outstays this floats over whatever the person switches to.
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'ChitChak',
    // The splash is the first thing in the taskbar on a cold start, so it needs
    // the icon too - otherwise launching the app briefly shows Electron's.
    icon: nativeImage.createFromDataURL(appIcon),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  window.once('ready-to-show', () => window.show());

  let closed = false;

  return {
    window,
    set(phase, percent) {
      if (closed || window.isDestroyed()) return;
      // executeJavaScript rather than IPC: this is one-way, a few times per
      // launch, and the alternative is a preload script and a channel for a
      // window whose entire job is to display two words.
      void window.webContents
        .executeJavaScript(`window.__splash?.(${JSON.stringify(phase)}, ${percent ?? 'null'})`)
        .catch(() => {
          /* The page may not have finished loading, or may already be gone. */
        });
    },
    close() {
      if (closed) return;
      closed = true;
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
