import { useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Create a server, or join one with an invite code.
 *
 * Both reload afterwards: the gateway captures a user's guild membership when
 * the socket identifies, so a guild joined mid-session does not route events
 * until the connection is re-established. Reconnecting is the honest fix until
 * the gateway grows a live membership update.
 */
export function GuildDialog({ mode, onClose }: { mode: 'create' | 'join'; onClose(): void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isCreate = mode === 'create';

  async function submit() {
    if (value.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      if (isCreate) await api.createGuild(value.trim());
      else await api.joinByInvite(value.trim());
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">{isCreate ? 'Create a server' : 'Join a server'}</h2>
          <p className="modal__sub">
            {isCreate
              ? 'You get a text channel and a voice room to start with.'
              : 'Paste the code someone shared with you.'}
          </p>
        </div>

        <div className="modal__body">
          <div className="field">
            <label className="field__label" htmlFor="guild-value">
              {isCreate ? 'Server name' : 'Invite code'}
            </label>
            <input
              id="guild-value"
              value={value}
              autoFocus
              className={isCreate ? undefined : 'mono'}
              style={isCreate ? undefined : { letterSpacing: '0.15em', textTransform: 'uppercase' }}
              placeholder={isCreate ? 'Friday Night Raids' : 'ABCD2345'}
              onChange={(e) => setValue(isCreate ? e.target.value : e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            {error && <div className="field__error">{error}</div>}
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || value.trim().length < 2}
            onClick={() => void submit()}
          >
            {busy ? 'Working…' : isCreate ? 'Create server' : 'Join server'}
          </button>
        </div>
      </div>
    </div>
  );
}
