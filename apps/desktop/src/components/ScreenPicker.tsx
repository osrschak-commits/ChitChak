import { useEffect, useState } from 'react';
import { useApp } from '../store/app.js';

interface Source {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string | null;
}

/**
 * Pick a screen or window to share.
 *
 * Electron has no built-in chooser, and `getDisplayMedia()` fails outright
 * unless the main process is told what to hand over - so this list is the
 * picker, and choosing here is what makes the share possible at all.
 */
export function ScreenPicker({
  onPick,
  onClose,
}: {
  onPick(sourceId: string, withAudio: boolean): void;
  onClose(): void;
}) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Computer sound is a Windows-only capability - see the loopback comment in
  // electron/main.ts - so elsewhere the answer is always no, whatever the
  // setting says.
  const canShareAudio = window.chitchak?.platform === 'win32';

  /*
    No longer a question asked here.

    Sharing a game, a video or a call without its sound is almost never what
    somebody meant to do, and the failure is silent on both ends: the sharer
    hears everything perfectly and nobody thinks to mention it for a while. So
    sound now comes as standard, and the one setting that turns it off lives in
    voice settings for the case that needs it.
  */
  const shareComputerSound = useApp((s) => s.shareComputerSound);
  const withAudio = canShareAudio && shareComputerSound;
  const [error, setError] = useState<string | null>(null);
  // macOS gates screen capture behind a system permission and, unhelpfully,
  // grants a useless version of it when denied: sources still come back, just
  // with generic names and the desktop picture as every thumbnail. Without
  // this the picker looks broken rather than blocked.
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const bridge = window.chitchak;
    if (!bridge) {
      setError('Screen sharing is only available in the desktop app.');
      setSources([]);
      return;
    }

    void bridge
      .getScreenAccess()
      .then((access) => setBlocked(access !== 'granted'))
      .catch(() => setBlocked(false));

    bridge
      .listScreenSources()
      .then((list) => {
        setSources(list);
        setSelected(list[0]?.id ?? null);
      })
      .catch(() => setError('Could not read the list of windows to share.'));
  }, []);

  const screens = sources?.filter((s) => s.kind === 'screen') ?? [];
  const windows = sources?.filter((s) => s.kind === 'window') ?? [];

  function renderGroup(label: string, list: Source[]) {
    if (list.length === 0) return null;
    return (
      <div className="section">
        <h3 className="section__title">{label}</h3>
        <div className="sources">
          {list.map((source) => (
            <button
              key={source.id}
              className={`source ${selected === source.id ? 'source--selected' : ''}`}
              onClick={() => setSelected(source.id)}
              onDoubleClick={() => onPick(source.id, withAudio)}
              title={source.name}
            >
              <span className="source__preview">
                {source.thumbnail ? (
                  <img src={source.thumbnail} alt="" draggable={false} />
                ) : (
                  <span className="legend">No preview</span>
                )}
              </span>
              <span className="source__name">{source.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Share your screen</h2>
          <p className="modal__sub">
            Everyone in the call sees this until you stop.
            {withAudio && ' Computer sound goes with it.'}
          </p>
        </div>

        <div className="modal__body">
          {error && <div className="notice">{error}</div>}
          {blocked && (
            <div className="notice">
              macOS has not granted ChitChak permission to record the screen, so this list is
              incomplete and anything you share will come out blank. Turn ChitChak on under
              Screen &amp; System Audio Recording, then quit and reopen the app — macOS only
              applies it on relaunch.{' '}
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => void window.chitchak?.openScreenSettings()}
              >
                Open Settings
              </button>
            </div>
          )}
          {sources === null && <p className="empty__body">Looking for windows…</p>}
          {sources !== null && sources.length === 0 && !error && (
            <p className="empty__body">Nothing available to share.</p>
          )}
          {renderGroup('Screens', screens)}
          {renderGroup('Windows', windows)}
        </div>

        <div className="modal__foot">
          {/* Said rather than asked. What gets sent is worth knowing before it
              is sent - especially that it is everything, including the call
              itself - but it is not a decision to make every single time. */}
          {canShareAudio && (
            <span className="picker__audio" style={{ marginRight: 'auto' }}>
              <span className="row__label">
                {withAudio ? 'Computer sound included' : 'Computer sound off'}
              </span>
              <span className="row__hint">
                {withAudio
                  ? 'Everything your PC is playing, including other people in this call.'
                  : 'Turn it back on in voice settings.'}
              </span>
            </span>
          )}

          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!selected}
            onClick={() => selected && onPick(selected, withAudio)}
          >
            Share
          </button>
        </div>
      </div>
    </div>
  );
}
