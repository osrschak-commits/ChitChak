import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EMOJI_GROUPS,
  recentEmoji,
  searchEmoji,
  type Emoji,
} from '../lib/emoji.js';

/**
 * The emoji picker.
 *
 * Opens above the composer rather than over the conversation: the thing you are
 * replying to is the reason you are reaching for an emoji, so covering it is
 * the one place it must not go.
 *
 * It closes on pick, on Escape and on a click outside, and it puts focus in the
 * search box on open - reaching for the picker is nearly always followed by
 * typing what you want rather than hunting through eight tabs.
 */
export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick(emoji: Emoji): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Read once on open. Picking updates the store, and a list that reorders
  // under the cursor mid-click is how you send the wrong emoji.
  const recent = useMemo(() => recentEmoji(), []);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Stopped here so Escape closes the picker without also reaching
        // whatever else on the page listens for it.
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  const results = query.trim() ? searchEmoji(query) : null;
  const showing = results ?? EMOJI_GROUPS[group]?.emoji ?? [];

  return (
    <div className="emoji" ref={panelRef} role="dialog" aria-label="Emoji">
      <div className="emoji__head">
        <input
          ref={searchRef}
          className="emoji__search"
          value={query}
          placeholder="Search emoji"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter takes the first result, so a search can be finished
            // without moving to the mouse.
            if (e.key === 'Enter' && showing[0]) {
              e.preventDefault();
              onPick(showing[0]);
            }
          }}
        />
      </div>

      {!results && recent.length > 0 && group === 0 && (
        <div className="emoji__section">
          <div className="emoji__label mono">Recent</div>
          <Grid emoji={recent} onPick={onPick} />
        </div>
      )}

      <div className="emoji__section emoji__section--grow">
        <div className="emoji__label mono">
          {results ? `${results.length || 'No'} match${results.length === 1 ? '' : 'es'}` : EMOJI_GROUPS[group]?.name}
        </div>
        {showing.length === 0 ? (
          <div className="emoji__empty">
            Nothing matches “{query.trim()}”. These are the standard set — custom ones are coming.
          </div>
        ) : (
          <Grid emoji={showing} onPick={onPick} />
        )}
      </div>

      {/* Hidden while searching: the tabs jump you out of the results you just
          typed, which is never what the click was for. */}
      {!results && (
        <div className="emoji__tabs">
          {EMOJI_GROUPS.map((entry, index) => (
            <button
              key={entry.name}
              className={`emoji__tab ${index === group ? 'emoji__tab--on' : ''}`}
              title={entry.name}
              aria-label={entry.name}
              aria-pressed={index === group}
              onClick={() => setGroup(index)}
            >
              {entry.tab}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Grid({ emoji, onPick }: { emoji: Emoji[]; onPick(emoji: Emoji): void }) {
  return (
    <div className="emoji__grid">
      {emoji.map((entry) => (
        <button
          key={entry.char}
          className="emoji__one"
          title={entry.name}
          aria-label={entry.name}
          onClick={() => onPick(entry)}
        >
          {entry.char}
        </button>
      ))}
    </div>
  );
}
