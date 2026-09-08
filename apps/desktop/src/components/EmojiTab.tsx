import { useEffect, useRef, useState } from 'react';
import { api, apiBase, uploadEmoji } from '../lib/api.js';
import { useApp } from '../store/app.js';

/**
 * The server's custom emoji.
 *
 * Adding one is part of Brass; using and removing them is not. An emoji only
 * half the room can see would turn a shared joke into a message that reads
 * differently depending on who is paying, and taking something down should
 * never be gated on a payment being current.
 */

/** Matches the server. Shown, so the refusal is not a surprise. */
const MAX_PER_GUILD = 50;
const MAX_KB = 256;

export function EmojiTab({ guildId }: { guildId: string }) {
  const emoji = useApp((s) => s.emoji);
  /*
    Asked here rather than read from the store, because subscription state is
    not in it - every surface that needs it fetches it. Null while unknown, so
    the panel does not flash "this is a Brass feature" at somebody who is
    paying for it.
  */
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .premium()
      .then((state) => {
        if (!cancelled) setSubscribed(state.subscription.active);
      })
      .catch(() => {
        if (!cancelled) setSubscribed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = [...emoji.values()]
    .filter((one) => one.guildId === guildId)
    .sort((a, b) => a.name.localeCompare(b.name));

  const full = mine.length >= MAX_PER_GUILD;

  async function add(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // The filename is the obvious default - somebody who saved a picture as
      // "shrug.png" has already named it.
      const wanted = name.trim() || file.name.replace(/\.[a-z0-9]+$/i, '');
      await uploadEmoji(guildId, wanted, file);
      // Nothing to set here: the gateway event that follows adds it to the
      // store for everyone in the server, this window included.
      setName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  async function remove(emojiId: string): Promise<void> {
    setError(null);
    try {
      await api.deleteEmoji(guildId, emojiId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
    }
  }

  return (
    <div className="settings__panel">
      <div className="section">
        <h3 className="section__title">
          Emoji ({mine.length} of {MAX_PER_GUILD})
        </h3>

        {subscribed === null ? (
          <p className="row__hint">Checking…</p>
        ) : !subscribed ? (
          <p className="row__hint">
            Adding custom emoji is part of Brass. Everyone in the server can use the ones that are
            already here, whether they subscribe or not.
          </p>
        ) : (
          <>
            <p className="row__hint" style={{ marginBottom: 12 }}>
              A square PNG, JPEG, GIF or WebP under {MAX_KB}KB. Named with letters, numbers and
              underscores — that name is what people type between colons.
            </p>

            <div className="emojitab__add">
              <input
                value={name}
                placeholder="name (optional)"
                spellCheck={false}
                autoComplete="off"
                disabled={busy || full}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              />
              <button
                className="btn btn--primary"
                type="button"
                disabled={busy || full}
                onClick={() => fileRef.current?.click()}
              >
                {busy ? 'Adding…' : 'Choose a picture'}
              </button>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void add(file);
              }}
            />

            {full && (
              <div className="field__hint">
                This server is full. Remove one to make room.
              </div>
            )}
            {error && <div className="field__error">{error}</div>}
          </>
        )}
      </div>

      <div className="section">
        <h3 className="section__title">In this server</h3>
        {mine.length === 0 ? (
          <p className="row__hint">None yet.</p>
        ) : (
          <div className="emojitab__list">
            {mine.map((one) => (
              <div className="emojitab__item" key={one.id}>
                <img src={`${apiBase}${one.url}`} alt="" draggable={false} />
                <span className="emojitab__name mono">:{one.name}:</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void remove(one.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
