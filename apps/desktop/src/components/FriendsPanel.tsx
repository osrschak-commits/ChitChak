import type { PublicUser } from '@chitchak/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, api } from '../lib/api.js';
import { useApp } from '../store/app.js';
import { Avatar } from './primitives.js';

/**
 * The friends surface: requests waiting, and the field for adding someone.
 *
 * Shown when Friends is selected and no conversation is open. Opening a
 * conversation replaces this with the ordinary chat panel, because a DM is an
 * ordinary channel and deserves the same reading experience.
 */
export function FriendsPanel() {
  const incoming = useApp((s) => s.incomingRequests);
  const outgoing = useApp((s) => s.outgoingRequests);
  const blocked = useApp((s) => s.blocked);
  const people = useApp((s) => s.people);
  const members = useApp((s) => s.members);
  const friends = useApp((s) => s.friends);

  const sendFriendRequest = useApp((s) => s.sendFriendRequest);
  const acceptFriendRequest = useApp((s) => s.acceptFriendRequest);
  const dismissRequest = useApp((s) => s.dismissRequest);
  const unblockPerson = useApp((s) => s.unblockPerson);

  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [blockedPeople, setBlockedPeople] = useState<PublicUser[]>([]);

  // The block list is not in the ready snapshot as profiles, only as ids, and
  // it is rarely looked at - so it is fetched when this panel opens rather than
  // carried in every reconnect.
  useEffect(() => {
    if (blocked.size === 0) {
      setBlockedPeople([]);
      return;
    }
    void api
      .listBlocked()
      .then(setBlockedPeople)
      .catch(() => setBlockedPeople([]));
  }, [blocked.size]);

  function personFor(userId: string): PublicUser | undefined {
    const known = people.get(userId);
    if (known) return known;
    for (const member of members.values()) {
      if (member.userId === userId) return member.user;
    }
    return undefined;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const wanted = username.trim().toLowerCase();
    if (!wanted) return;

    setBusy(true);
    setError(null);
    setSent(null);
    try {
      await sendFriendRequest(wanted);
      setUsername('');
      setSent(wanted);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not reach the server',
      );
    } finally {
      setBusy(false);
    }
  }

  function renderRow(userId: string, actions: React.ReactNode) {
    const person = personFor(userId);
    if (!person) return null;
    return (
      <div className="friends__request" key={userId}>
        <Avatar user={person} size={30} />
        <div className="friends__who">
          <span className="row__label">{person.displayName}</span>
          <span className="row__hint mono">{person.username}</span>
        </div>
        <div className="friends__actions">{actions}</div>
      </div>
    );
  }

  return (
    /*
      `pane`, the same shell the chat panel uses, because this occupies the
      same column and should sit in it the same way. It previously used a
      `main` family of its own that no stylesheet had ever defined, so the
      whole panel rendered unstyled - flush to the left edge, with the buttons
      running off the right.
    */
    <main className="pane">
      <header className="pane__header">
        <span className="pane__title">Friends</span>
      </header>

      <div className="pane__body">
        <p className="pane__lede">
          {friends.size === 0
            ? 'Nobody yet. Add someone by their exact username.'
            : `${friends.size} ${friends.size === 1 ? 'friend' : 'friends'}. Pick one on the left to talk.`}
        </p>

        <div className="section">
          <h3 className="section__title">Add a friend</h3>
          <form className="friends__add" onSubmit={submit}>
            <input
              value={username}
              placeholder="their exact username"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setUsername(e.target.value.toLowerCase().replace(/\s+/g, ''));
                setError(null);
                setSent(null);
              }}
            />
            <button className="btn btn--primary" type="submit" disabled={busy || !username.trim()}>
              {busy ? 'Sending…' : 'Send request'}
            </button>
          </form>
          {error && <div className="field__error">{error}</div>}
          {sent && (
            <div className="field__hint">
              Request sent to <strong>{sent}</strong>. They will see it next time they are online.
            </div>
          )}
          {!error && !sent && (
            <div className="field__hint">
              Usernames are exact — there is no search, so nobody can be found by guessing.
            </div>
          )}
        </div>

        {incoming.size > 0 && (
          <div className="section">
            <h3 className="section__title">Waiting for you ({incoming.size})</h3>
            {[...incoming].map((userId) =>
              renderRow(
                userId,
                <>
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={() => void acceptFriendRequest(userId)}
                  >
                    Accept
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => void dismissRequest(userId)}
                  >
                    Decline
                  </button>
                </>,
              ),
            )}
          </div>
        )}

        {outgoing.size > 0 && (
          <div className="section">
            <h3 className="section__title">Sent ({outgoing.size})</h3>
            {[...outgoing].map((userId) =>
              renderRow(
                userId,
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => void dismissRequest(userId)}
                >
                  Cancel
                </button>,
              ),
            )}
          </div>
        )}

        {blockedPeople.length > 0 && (
          <div className="section">
            <h3 className="section__title">Blocked ({blockedPeople.length})</h3>
            <p className="row__hint" style={{ marginBottom: 10 }}>
              They cannot send you requests or messages. Unblocking does not make you friends
              again.
            </p>
            {blockedPeople.map((person) => (
              <div className="friends__request" key={person.id}>
                <Avatar user={person} size={30} />
                <div className="friends__who">
                  <span className="row__label">{person.displayName}</span>
                  <span className="row__hint mono">{person.username}</span>
                </div>
                <div className="friends__actions">
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => void unblockPerson(person.id)}
                  >
                    Unblock
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
