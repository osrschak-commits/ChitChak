import type { WornBadge } from '../lib/api.js';

/**
 * A badge beside somebody's name.
 *
 * Drawn from artwork where there is artwork, and from its glyph where there is
 * not - so badges can be designed one at a time without every un-drawn one
 * turning into a missing image in the meantime.
 *
 * Hovering says what it is. A mark nobody can identify is just decoration; the
 * point of a badge is that it means something, so the meaning has to be one
 * hover away rather than buried in a shop somebody has to go and find.
 */

/**
 * Every badge picture in the folder, found at build time.
 *
 * A glob rather than a hand-written map: adding a badge is then dropping a file
 * called `<cosmetic id>.svg` into src/assets/badges, with nothing to remember
 * to register. Eager, because these are a couple of kilobytes each and a lazy
 * import would make a badge fade in after the name it belongs to.
 */
const ARTWORK = import.meta.glob('../assets/badges/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export function artworkFor(id: string): string | null {
  const match = Object.entries(ARTWORK).find(([path]) => path.endsWith(`/${id}.svg`));
  return match ? match[1] : null;
}

export function Badge({ badge }: { badge: WornBadge }) {
  const art = artworkFor(badge.id);

  return (
    <span className="badge" tabIndex={0}>
      {art ? (
        <img
          className="badge__art"
          src={art}
          // The name, not "badge": a screen reader saying "Founder" after a
          // name is the same information the picture gives everybody else.
          alt={badge.name}
          draggable={false}
        />
      ) : (
        <span className="badge__glyph mono" aria-label={badge.name}>
          {badge.value}
        </span>
      )}

      {/* Not `title`: the native tooltip waits a second, cannot show two lines,
          and cannot be styled to look like it belongs here. */}
      <span className="badge__tip" role="tooltip">
        <span className="badge__tip-name">{badge.name}</span>
        <span className="badge__tip-blurb">{badge.blurb}</span>
      </span>
    </span>
  );
}
