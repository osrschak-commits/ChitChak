import { useEffect } from 'react';
import { useApp } from '../store/app.js';

/** Long enough to read twice, short enough not to sit over a conversation. */
const DISMISS_AFTER_MS = 6_000;

/**
 * What just happened, said once and then got out of the way.
 *
 * Deliberately in the bottom corner and deliberately silent: someone levels up
 * mid-sentence, and the reward for talking should never be something that
 * covers what was being said.
 */
export function Celebrations() {
  const celebrations = useApp((s) => s.celebrations);
  const dismiss = useApp((s) => s.dismissCelebration);

  const oldest = celebrations[0]?.key;

  useEffect(() => {
    if (!oldest) return;
    // Timed off the oldest, so a burst of tasks completing together clears one
    // at a time rather than all vanishing at whatever moment the last arrived.
    const timer = setTimeout(() => dismiss(oldest), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [oldest, dismiss]);

  if (celebrations.length === 0) return null;

  return (
    <div className="celebrations" role="status" aria-live="polite">
      {celebrations.map((celebration) => (
        <button
          key={celebration.key}
          type="button"
          className={`celebration celebration--${celebration.kind}`}
          onClick={() => dismiss(celebration.key)}
          title="Dismiss"
        >
          <span className="celebration__mark" aria-hidden="true">
            {celebration.kind === 'level' ? '▲' : '◆'}
          </span>
          <span className="celebration__text">
            <span className="celebration__title">{celebration.title}</span>
            <span className="celebration__detail">{celebration.detail}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
