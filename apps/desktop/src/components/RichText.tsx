import type { Emoji } from '@chitchak/protocol';
import { Fragment, useMemo } from 'react';
import { apiBase } from '../lib/api.js';
import { useApp } from '../store/app.js';

/**
 * Message text with `:name:` swapped for the server's custom emoji.
 *
 * Done at draw time rather than on the way in. The message keeps the words
 * somebody actually typed, which means an emoji that is later deleted degrades
 * to `:name:` instead of a broken image, search still matches the text, and a
 * message quoted anywhere that has no emoji list is still readable.
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
const TOKEN = /:([a-z0-9_]{2,32}):/gi;

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

  const byName = useMemo(() => {
    const map = new Map<string, Emoji>();
    if (!guildId) return map;
    for (const one of emoji.values()) {
      if (one.guildId === guildId) map.set(one.name, one);
    }
    return map;
  }, [emoji, guildId]);

  const parts = useMemo(() => split(text), [text]);

  const found = parts.filter((part) => part.emoji && byName.has(part.value));
  const onlyEmoji =
    found.length > 0 &&
    found.length <= BIG_LIMIT &&
    parts.every((part) => (part.emoji && byName.has(part.value)) || part.value.trim() === '');

  return (
    <>
      {parts.map((part, index) => {
        const custom = part.emoji ? byName.get(part.value) : undefined;
        if (!custom) {
          // Either ordinary text, or a `:word:` this server has no emoji for -
          // in which case it stays exactly as it was written.
          return <Fragment key={index}>{part.emoji ? `:${part.value}:` : part.value}</Fragment>;
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
      })}
    </>
  );
}

interface Part {
  value: string;
  emoji: boolean;
}

/** Splits text into runs of plain text and `:name:` tokens. */
function split(text: string): Part[] {
  const parts: Part[] = [];
  let at = 0;

  // The regex is module-level and global, so its lastIndex has to be reset -
  // otherwise the second message rendered starts scanning where the first one
  // stopped and quietly misses tokens.
  TOKEN.lastIndex = 0;

  let match = TOKEN.exec(text);
  while (match) {
    if (match.index > at) parts.push({ value: text.slice(at, match.index), emoji: false });
    parts.push({ value: (match[1] ?? '').toLowerCase(), emoji: true });
    at = match.index + match[0].length;
    match = TOKEN.exec(text);
  }

  if (at < text.length) parts.push({ value: text.slice(at), emoji: false });
  return parts;
}
