import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/app.js';

/**
 * Create a server, or join one with an invite code.
 *
 * Both finish by reconnecting the gateway rather than reloading the window. The
 * gateway captures a user's guild membership when it identifies, so a server
 * joined mid-session would otherwise receive none of its events. Reloading the
 * whole app achieved that too, but it threw away the window to do it - and in a
 * packaged build the navigation guard blocked the reload outright, leaving this
 * dialog stuck on "Working" while the server had in fact been created.
 */
export function GuildDialog({ mode, onClose }: { mode: 'create' | 'join'; onClose(): void }) {
  const enterGuild = useApp((s) => s.enterGuild);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isCreate = mode === 'create';

  async function submit() {
    if (value.trim().length < 2 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const guildId = isCreate
        ? (await api.createGuild(value.trim())).guild.id
        : (await api.joinByInvite(value.trim())).guild.id;

      await enterGuild(guildId);
      onClose();
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
              disabled={busy}
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
          <button className="btn btn--ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || value.trim().length < 2}
            onClick={() => void submit()}
          >
            {busy ? (isCreate ? 'Creating…' : 'Joining…') : isCreate ? 'Create server' : 'Join server'}
          </button>
        </div>
      </div>
    </div>
  );
}
