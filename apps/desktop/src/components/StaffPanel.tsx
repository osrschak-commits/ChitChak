import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { ModerationPanel } from './ModerationPanel.js';

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
    Array<{
      at: string;
      actor: string;
      subject: string | null;
      detail: string | null;
      action: string;
    }>
  >([]);
  /** Who is one click from losing a card. Confirming is deliberate - see below. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = () =>
    void api
      .listBlackCards()
      .then((result) => setCards(result.cards))
      .catch(() => setCards([]));

  useEffect(refresh, []);

  /**
   * Takes a card back.
   *
   * Behind a confirmation, because it is the one action here that removes
   * something somebody already has, and there is no undo - re-issuing gives a
   * fresh year rather than the remainder of the one taken away.
   */
  async function revoke(name: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.revokeBlackCard(name);
      setNote(
        result.keysTaken > 0
          ? `${result.username} no longer has Brass. ${result.keysTaken} unspent ${
              result.keysTaken === 1 ? 'key' : 'keys'
            } taken back.`
          : `${result.username} no longer has Brass. Their keys were already spent.`,
      );
      setConfirming(null);
      refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

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
      {/* Reports first: a card is something you give when you feel like it, a
          report is somebody waiting. */}
      <ModerationPanel />

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
        <h3 className="section__title">Cards ({cards.length})</h3>
        {cards.length === 0 ? (
          <p className="empty__body">None yet.</p>
        ) : (
          <div className="shop">
            {cards.map((card) => {
              const taken = card.action === 'black_card_revoke';
              const name = card.subject ?? 'unknown';
              return (
                <div key={card.at + name} className="shopitem">
                  <div className="shopitem__text">
                    <span className="shopitem__name">
                      {name}
                      {/* A revocation sitting in a list of grants has to say so,
                          or the history reads as though the card is still held. */}
                      {taken && <span className="staff__taken mono">taken back</span>}
                    </span>
                    <span className="shopitem__blurb">
                      by {card.actor} · {new Date(card.at).toLocaleString()}
                    </span>
                  </div>

                  {!taken &&
                    (confirming === name ? (
                      <div className="staff__confirm">
                        <button
                          className="btn btn--danger btn--sm"
                          disabled={busy}
                          onClick={() => void revoke(name)}
                        >
                          {busy ? 'Taking…' : 'Take it back'}
                        </button>
                        <button
                          className="btn btn--ghost btn--sm"
                          disabled={busy}
                          onClick={() => setConfirming(null)}
                        >
                          Keep
                        </button>
                      </div>
                    ) : (
                      <button className="btn btn--ghost btn--sm" onClick={() => setConfirming(name)}>
                        Revoke
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="section">
        <h3 className="section__title">What this account can do</h3>
        <p className="row__hint" style={{ maxWidth: 440 }}>
          Moderate in any server, including ones you are not in and including their owners. It does
          not let you read private conversations or join channels you were not admitted to — the
          reach is over behaviour, not over what people say. Every card, suspension and report
          decision is recorded against your name.
        </p>
      </div>
    </>
  );
}
