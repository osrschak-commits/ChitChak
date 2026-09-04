import { useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Creating a channel. Used from the sidebar's + buttons and from server
 * settings, so it lives on its own rather than inside either.
 */
export function CreateChannelDialog({
  guildId,
  kind,
  onClose,
}: {
  guildId: string;
  kind: 'text' | 'voice';
  onClose(): void;
}) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [userLimit, setUserLimit] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createChannel(guildId, {
        name: name.trim(),
        kind,
        topic: topic.trim() || undefined,
        userLimit,
      });
      // No local insert: the server broadcasts channel:create and the store
      // applies it, so this client takes the same path as everyone else.
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the channel');
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">New {kind} channel</h2>
          <p className="modal__sub">
            {kind === 'text'
              ? 'A place to write things down.'
              : 'A room people can drop into and talk.'}
          </p>
        </div>

        <div className="modal__body">
          <div className="field">
            <label className="field__label" htmlFor="new-channel-name">
              Name
            </label>
            <input
              id="new-channel-name"
              value={name}
              autoFocus
              placeholder={kind === 'text' ? 'announcements' : 'Lounge'}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            {error && <div className="field__error">{error}</div>}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="new-channel-topic">
              Topic (optional)
            </label>
            <input
              id="new-channel-topic"
              value={topic}
              placeholder="What is this channel for?"
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>

          {kind === 'voice' && (
            <div className="field">
              <label className="field__label" htmlFor="new-channel-limit">
                User limit
              </label>
              <input
                id="new-channel-limit"
                type="number"
                min={0}
                max={99}
                value={userLimit}
                onChange={(e) => setUserLimit(Number(e.target.value))}
              />
              <div className="field__hint">0 means anyone can join, however many.</div>
            </div>
          )}
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create channel'}
          </button>
        </div>
      </div>
    </div>
  );
}
