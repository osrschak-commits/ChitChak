import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '@chitchak/protocol';
import { api } from '../lib/api.js';
import { useApp } from '../store/app.js';
import { Avatar } from './primitives.js';

/**
 * Search, one channel at a time.
 *
 * Opens over the channel it searches rather than in a dialog, because the
 * results are about this conversation and closing it should put you straight
 * back into it.
 *
 * `from:someone` is parsed here rather than sent to the server. The client
 * already knows every member of the guild by name and nickname, so it can turn
 * a name into an id without a round trip - and it can say "no such person"
 * immediately instead of quietly searching everybody.
 */

/** Long enough that typing a word does not fire three searches. */
const DEBOUNCE_MS = 300;

interface Parsed {
  /** What is left after the filters are taken out. */
  text: string;
  /** The name written after `from:`, if any. */
  from: string | null;
}

export function parseQuery(raw: string): Parsed {
  let from: string | null = null;
  // Quoted so a name with a space works: from:"jo bloggs".
  const text = raw
    .replace(/\bfrom:("([^"]*)"|\S+)/i, (_match, _quoted, inQuotes) => {
      from = (inQuotes ?? _quoted.replace(/^"|"$/g, '')) as string;
      return '';
    })
    .trim();
  return { text, from };
}

export function SearchPanel({
  channelId,
  channelName,
  onClose,
}: {
  channelId: string;
  channelName: string;
  onClose(): void;
}) {
  const members = useApp((s) => s.members);
  const people = useApp((s) => s.people);
  const self = useApp((s) => s.user);
  const selectedGuildId = useApp((s) => s.selectedGuildId);

  const [raw, setRaw] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const parsed = useMemo(() => parseQuery(raw), [raw]);

  /** Everyone this channel could plausibly be searched by. */
  const candidates = useMemo(() => {
    const found = new Map<string, { id: string; name: string; nickname: string | null }>();
    for (const member of members.values()) {
      if (selectedGuildId && member.guildId !== selectedGuildId) continue;
      found.set(member.userId, {
        id: member.userId,
        name: member.user.displayName,
        nickname: member.nickname,
      });
    }
    // DMs have no members; the two people in one are known from elsewhere.
    for (const person of people.values()) {
      if (!found.has(person.id)) found.set(person.id, { id: person.id, name: person.displayName, nickname: null });
    }
    if (self && !found.has(self.id)) {
      found.set(self.id, { id: self.id, name: self.displayName, nickname: null });
    }
    return [...found.values()];
  }, [members, people, self, selectedGuildId]);

  const author = useMemo(() => {
    if (!parsed.from) return null;
    const needle = parsed.from.toLowerCase();
    return (
      candidates.find(
        (person) =>
          person.name.toLowerCase() === needle || person.nickname?.toLowerCase() === needle,
      ) ??
      candidates.find(
        (person) =>
          person.name.toLowerCase().startsWith(needle) ||
          person.nickname?.toLowerCase().startsWith(needle),
      ) ??
      null
    );
  }, [parsed.from, candidates]);

  const unknownPerson = parsed.from !== null && author === null;

  useEffect(() => {
    // Nothing to search for. An empty box shows the hint, not zero results.
    if (parsed.text.length === 0 && !author) {
      setResults(null);
      setSearching(false);
      return;
    }
    if (unknownPerson) {
      setResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    let current = true;
    const timer = setTimeout(() => {
      void api
        .searchMessages(channelId, {
          // Empty text with an author is a real search - everything that
          // person said here - and the server treats it as one.
          q: parsed.text,
          authorId: author?.id,
          limit: 25,
        })
        .then((found) => {
          if (!current) return;
          setResults(found);
          setError(null);
        })
        .catch((problem: unknown) => {
          if (!current) return;
          setError(problem instanceof Error ? problem.message : 'Search failed');
          setResults([]);
        })
        .finally(() => current && setSearching(false));
    }, DEBOUNCE_MS);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [parsed.text, author, unknownPerson, channelId]);

  const nameOf = (userId: string) =>
    candidates.find((person) => person.id === userId)?.nickname ??
    candidates.find((person) => person.id === userId)?.name ??
    'Unknown';

  return (
    <div className="search">
      <div className="search__bar">
        <input
          ref={input}
          className="search__input"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onClose()}
          placeholder={`Search #${channelName} — try from:someone`}
          aria-label={`Search ${channelName}`}
        />
        <button className="btn btn--ghost btn--sm" onClick={onClose} title="Close search (Esc)">
          Close
        </button>
      </div>

      <div className="search__results">
        {unknownPerson && (
          <p className="empty__body">Nobody here is called “{parsed.from}”.</p>
        )}

        {error && <div className="notice">{error}</div>}

        {!unknownPerson && results === null && !searching && (
          <p className="empty__body">
            Searching this channel only. Quote a phrase to match it exactly, put a minus in front of
            a word to leave it out, or use <span className="mono">from:</span> to pick a person.
          </p>
        )}

        {searching && results === null && <p className="empty__body">Searching…</p>}

        {results !== null && results.length === 0 && !searching && !error && (
          <p className="empty__body">Nothing found.</p>
        )}

        {results?.map((message) => {
          const when = new Date(message.createdAt);
          return (
            <div key={message.id} className="hit">
              <Avatar
                user={
                  members.get(`${selectedGuildId}:${message.authorId}`)?.user ??
                  people.get(message.authorId) ??
                  (message.authorId === self?.id && self ? self : undefined) ?? {
                    id: message.authorId,
                    displayName: nameOf(message.authorId),
                    avatarUrl: null,
                    accentColor: null,
                  }
                }
                size={26}
              />
              <div className="hit__body">
                <div className="hit__meta">
                  <span className="hit__author">{nameOf(message.authorId)}</span>
                  <span className="hit__when mono" title={when.toLocaleString()}>
                    {when.toLocaleDateString([], { day: 'numeric', month: 'short' })}{' '}
                    {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="hit__text">{message.content}</div>
              </div>
            </div>
          );
        })}

        {results !== null && results.length > 0 && (
          <p className="search__foot legend mono">
            {results.length === 25 ? 'first 25 matches' : `${results.length} found`}
          </p>
        )}
      </div>
    </div>
  );
}
