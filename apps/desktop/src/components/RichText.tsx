import type { Emoji } from '@chitchak/protocol';
import { Fragment, useMemo } from 'react';
import { apiBase } from '../lib/api.js';
import { useApp } from '../store/app.js';

/**
 * Message text with the two tokens the client resolves at draw time swapped for
 * what they mean: `:name:` for a custom emoji, and `<@id>` for a mention.
 *
 * Done at draw time rather than on the way in. The message keeps the words
 * somebody actually typed - or, for a mention, the id, which does not change -
 * which means an emoji that is later deleted degrades to `:name:`, a mention of
 * a departed account degrades to `@unknown`, search still matches the text, and
 * a message quoted anywhere that has no emoji or member list is still readable.
 *
 * Only the emoji of the guild the message is in resolve. Two servers calling
 * their own picture `:yes:` is normal, and each should mean its own.
 */

/**
 * A name between colons, with no whitespace inside.
 *
 * Deliberately narrow. A looser pattern turns ordinary prose - a time like
 * "10:30 to 11:00" or a path - into a hunt for emoji that are not there.
 */
const EMOJI_TOKEN = /:([a-z0-9_]{2,32}):/i;
/** `<@` then a snowflake then `>` - exactly what the composer inserts. */
const MENTION_TOKEN = /<@(\d{1,20})>/;
/** Either token, captured, so one pass over the text splits on both. */
const ANY_TOKEN = new RegExp(`${EMOJI_TOKEN.source}|${MENTION_TOKEN.source}`, 'gi');

/**
 * When a message is nothing but emoji, they are drawn larger.
 *
 * A reaction sent on its own is the message, not decoration inside one, and at
 * text size it reads as a typo. Three is the usual cut-off: past that it is a
 * wall rather than a gesture.
 */
const BIG_LIMIT = 3;

export function RichText({ text, guildId }: { text: string; guildId: string | null }) {
  const emoji = useApp((s) => s.emoji);
  const members = useApp((s) => s.members);
  const people = useApp((s) => s.people);
  const selfId = useApp((s) => s.user?.id);
  const selfName = useApp((s) => s.user?.displayName);

  const byName = useMemo(() => {
    const map = new Map<string, Emoji>();
    if (!guildId) return map;
    for (const one of emoji.values()) {
      if (one.guildId === guildId) map.set(one.name, one);
    }
    return map;
  }, [emoji, guildId]);

  const parts = useMemo(() => split(text), [text]);

  /** The name to show for a mentioned id, or null to leave the raw token. */
  function mentionName(id: string): string | null {
    if (id === selfId) return selfName ?? 'you';
    const member = guildId ? members.get(`${guildId}:${id}`) : undefined;
    if (member) return member.nickname ?? member.user.displayName;
    const person = people.get(id);
    if (person) return person.displayName;
    return 'unknown';
  }

  const foundEmoji = parts.filter((part) => part.kind === 'emoji' && byName.has(part.value));
  const onlyEmoji =
    foundEmoji.length > 0 &&
    foundEmoji.length <= BIG_LIMIT &&
    parts.every(
      (part) =>
        (part.kind === 'emoji' && byName.has(part.value)) ||
        (part.kind === 'text' && part.value.trim() === ''),
    );

  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === 'mention') {
          const name = mentionName(part.value);
          if (name === null) return <Fragment key={index}>{`<@${part.value}>`}</Fragment>;
          return (
            <span
              key={index}
              className={`mention ${part.value === selfId ? 'mention--me' : ''}`}
            >
              @{name}
            </span>
          );
        }

        if (part.kind === 'emoji') {
          const custom = byName.get(part.value);
          if (!custom) {
            // A `:word:` this server has no emoji for stays exactly as written.
            return <Fragment key={index}>{`:${part.value}:`}</Fragment>;
          }
          return (
            <img
              key={index}
              className={`cemoji ${onlyEmoji ? 'cemoji--big' : ''}`}
              src={`${apiBase}${custom.url}`}
              alt={`:${custom.name}:`}
              title={`:${custom.name}:`}
              draggable={false}
              loading="lazy"
            />
          );
        }

        return <Fragment key={index}>{part.value}</Fragment>;
      })}
    </>
  );
}

interface Part {
  value: string;
  kind: 'text' | 'emoji' | 'mention';
}

/** Splits text into runs of plain text, `:name:` emoji, and `<@id>` mentions. */
function split(text: string): Part[] {
  const parts: Part[] = [];
  let at = 0;

  // The regex is module-level and global, so its lastIndex has to be reset -
  // otherwise the second message rendered starts scanning where the first one
  // stopped and quietly misses tokens.
  ANY_TOKEN.lastIndex = 0;

  let match = ANY_TOKEN.exec(text);
  while (match) {
    if (match.index > at) parts.push({ value: text.slice(at, match.index), kind: 'text' });
    // Group 1 is the emoji name; group 2 is the mention id - exactly one fires.
    if (match[1] !== undefined) {
      parts.push({ value: match[1].toLowerCase(), kind: 'emoji' });
    } else if (match[2] !== undefined) {
      parts.push({ value: match[2], kind: 'mention' });
    }
    at = match.index + match[0].length;
    match = ANY_TOKEN.exec(text);
  }

  if (at < text.length) parts.push({ value: text.slice(at), kind: 'text' });
  return parts;
}
