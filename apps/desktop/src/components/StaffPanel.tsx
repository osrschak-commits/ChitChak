import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * The operator's panel.
 *
 * Only rendered for staff, and only because the server said so - the tab is
 * hidden otherwise, and hiding it is a courtesy rather than the control. Every
 * route behind it checks again, and refuses in the same words an ordinary user
 * gets for anything they may not do.
 */
export function StaffPanel() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cards, setCards] = useState<
    Array<{ at: string; actor: string; subject: string | null; detail: string | null }>
  >([]);

  const refresh = () =>
    void api
      .listBlackCards()
      .then((result) => setCards(result.cards))
      .catch(() => setCards([]));

  useEffect(refresh, []);

  async function give() {
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.issueBlackCard(name);
      setNote(`${result.username} has a year of Brass and 24 keys.`);
      setUsername('');
      refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section">
        <h3 className="section__title">Black card</h3>
        <p className="row__hint" style={{ marginBottom: 12, maxWidth: 420 }}>
          A year of Brass and 24 keys, given rather than sold. Extends whatever they already have
          rather than replacing it.
        </p>

        <div className="staff__give">
          <input
            className="staff__input"
            value={username}
            placeholder="username"
            onChange={(event) => setUsername(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void give()}
            aria-label="Username to give a black card to"
          />
          <button className="btn btn--sm" disabled={busy || !username.trim()} onClick={() => void give()}>
            {busy ? 'Giving…' : 'Give a card'}
          </button>
        </div>

        {error && <div className="notice" style={{ marginTop: 12 }}>{error}</div>}
        {note && <p className="row__hint" style={{ marginTop: 12 }}>{note}</p>}
      </div>

      <div className="section">
        <h3 className="section__title">Cards given ({cards.length})</h3>
        {cards.length === 0 ? (
          <p className="empty__body">None yet.</p>
        ) : (
          <div className="shop">
            {cards.map((card) => (
              <div key={card.at + card.subject} className="shopitem">
                <div className="shopitem__text">
                  <span className="shopitem__name">{card.subject ?? 'unknown'}</span>
                  <span className="shopitem__blurb">
                    by {card.actor} · {new Date(card.at).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <h3 className="section__title">What this account can do</h3>
        <p className="row__hint" style={{ maxWidth: 440 }}>
          Moderate in any server, including ones you are not in and including their owners. It does
          not let you read private conversations or join channels you were not admitted to — the
          reach is over behaviour, not over what people say. Every card given is recorded.
        </p>
      </div>
    </>
  );
}
