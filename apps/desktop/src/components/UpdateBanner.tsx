import { useEffect, useState } from 'react';

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string; url: string | null }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };

/**
 * Update indicator in the top bar.
 *
 * Shows nothing until there is genuinely something to say, which is most of the
 * time. Restarting is always the user's choice - an update that closes the app
 * during a call would be worse than an out-of-date app - and the installer runs
 * on quit anyway, so ignoring this entirely still gets you the new version the
 * next time you open ChitChak.
 *
 * On macOS the app cannot update itself - it is not signed, and Squirrel.Mac
 * will not install what it cannot verify - so the same button opens the
 * download instead. See electron/updater.ts.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    // The state is asked for as well as subscribed to: the download may finish
    // before this component mounts, and a missed event would mean the banner
    // never appears.
    void window.chitchak?.getUpdateState().then(setState);
    return window.chitchak?.onUpdateState(setState);
  }, []);

  if (state.phase === 'downloading') {
    return (
      <span className="update update--quiet mono" title={`Downloading ChitChak ${state.version}`}>
        Updating {state.percent}%
      </span>
    );
  }

  if (state.phase === 'available') {
    return (
      <button
        className="update"
        disabled={state.url === null}
        title={
          state.url
            ? `ChitChak ${state.version} is out. Opens the download; drag it to Applications as before.`
            : `ChitChak ${state.version} is out. Download it from wherever you got this copy.`
        }
        onClick={() => void window.chitchak?.installUpdate()}
      >
        <span className="update__dot" aria-hidden="true" />
        Update available · Download
      </button>
    );
  }

  if (state.phase !== 'ready') return null;

  return (
    <button
      className="update"
      disabled={restarting}
      title={`ChitChak ${state.version} is ready. Installs when you next close the app.`}
      onClick={() => {
        setRestarting(true);
        void window.chitchak?.installUpdate();
      }}
    >
      <span className="update__dot" aria-hidden="true" />
      {restarting ? 'Restarting…' : 'Update ready · Restart'}
    </button>
  );
}
