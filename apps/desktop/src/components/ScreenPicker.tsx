import { useEffect, useState } from 'react';

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
  // Off by default. Sharing computer sound captures everything playing on the
  // machine - other calls, music, notifications - not just what is on screen.
  const [withAudio, setWithAudio] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.chitchak;
    if (!bridge) {
      setError('Screen sharing is only available in the desktop app.');
      setSources([]);
      return;
    }
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
            Everyone in the call sees this until you stop. System audio is included on Windows.
          </p>
        </div>

        <div className="modal__body">
          {error && <div className="notice">{error}</div>}
          {sources === null && <p className="empty__body">Looking for windows…</p>}
          {sources !== null && sources.length === 0 && !error && (
            <p className="empty__body">Nothing available to share.</p>
          )}
          {renderGroup('Screens', screens)}
          {renderGroup('Windows', windows)}
        </div>

        <div className="modal__foot">
          <label className="picker__audio" style={{ marginRight: 'auto' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={withAudio}
              onChange={(e) => setWithAudio(e.target.checked)}
            />
            <span>
              <span className="row__label">Share computer sound</span>
              <span className="row__hint">
                Sends everything your PC is playing, not just this window.
              </span>
            </span>
          </label>

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
