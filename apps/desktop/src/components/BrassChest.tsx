import { useEffect, useState } from 'react';
import { api, type ChestResult, type ChestStatus, type Rarity } from '../lib/api.js';

/**
 * The brass chest.
 *
 * A key in, a cosmetic out. The roll is the server's - this only plays the
 * moment and shows what arrived, which is why the animation runs on a result
 * that is already known rather than deciding anything.
 *
 * The odds are printed on the front, not behind a link. They are published
 * because that is the decent way to run a randomised reward, and putting them
 * where the button is means nobody has to go looking for them to find out what
 * they are spending on.
 */

const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

const RARITY_NAMES: Record<Rarity, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
};

/** How long the lid takes. Long enough to feel like something, short enough to
    sit through every time. */
const OPENING_MS = 1400;

export function BrassChest({
  status,
  keys,
  onOpened,
}: {
  status: ChestStatus;
  keys: number;
  onOpened(result: ChestResult): void;
}) {
  const [phase, setPhase] = useState<'idle' | 'opening' | 'revealed'>('idle');
  const [result, setResult] = useState<ChestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const complete = status.collected >= status.total;
  const affordable = keys >= status.cost;

  // Cleared if the panel is closed mid-animation, so a timer cannot fire into
  // a component that has gone.
  useEffect(() => {
    if (phase !== 'opening') return;
    const timer = setTimeout(() => setPhase('revealed'), OPENING_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  async function open(): Promise<void> {
    setError(null);
    setPhase('opening');
    try {
      const opened = await api.openChest();
      setResult(opened);
      // The parent refreshes its own idea of keys and ownership; the reveal
      // below shows the item itself.
      onOpened(opened);
    } catch (cause) {
      setPhase('idle');
      setError(cause instanceof Error ? cause.message : 'That did not work');
    }
  }

  return (
    <div className="section">
      <h3 className="section__title">Brass chest</h3>

      <div className="chest">
        <div className={`chest__box chest__box--${phase}`} aria-hidden="true">
          <span className="chest__lid" />
          <span className="chest__glow" />
          <span className="chest__mark">{phase === 'revealed' ? '' : '🔒'}</span>
        </div>

        {phase === 'revealed' && result ? (
          <div className={`chest__prize chest__prize--${result.cosmetic.rarity ?? 'common'}`}>
            <Preview item={result.cosmetic} />
            <div className="chest__won">
              <span className="chest__rarity mono">
                {RARITY_NAMES[result.cosmetic.rarity ?? 'common']}
              </span>
              <span className="chest__name">{result.cosmetic.name}</span>
              <span className="row__hint">{result.cosmetic.blurb}</span>
              <span className="chest__count mono">
                {result.collected} of {result.total} collected
              </span>
            </div>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setResult(null);
                setPhase('idle');
              }}
            >
              Done
            </button>
          </div>
        ) : (
          <div className="chest__side">
            <p className="row__hint">
              One key, one cosmetic, kept on your account. It never gives you something you already
              have — so every chest is something new, until you have them all.
            </p>

            <div className="chest__odds">
              {RARITY_ORDER.map((rarity) => (
                <span className={`chest__odd chest__odd--${rarity}`} key={rarity}>
                  <span className="chest__odd-name">{RARITY_NAMES[rarity]}</span>
                  <span className="mono">{status.rates[rarity]}%</span>
                </span>
              ))}
            </div>

            <div className="chest__actions">
              <button
                className="btn btn--primary"
                disabled={phase === 'opening' || complete || !affordable}
                onClick={() => void open()}
              >
                {phase === 'opening'
                  ? 'Opening…'
                  : `Open for ${status.cost} key${status.cost === 1 ? '' : 's'}`}
              </button>
              <span className="chest__count mono">
                {status.collected} of {status.total} collected
              </span>
            </div>

            {complete && (
              <div className="field__hint">
                You have everything the chest can give. More arrive with new collections.
              </div>
            )}
            {!complete && !affordable && (
              <div className="field__hint">
                You need {status.cost - keys} more key{status.cost - keys === 1 ? '' : 's'}.
              </div>
            )}
            {error && <div className="field__error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** The item itself, drawn the way it will look when worn. */
function Preview({ item }: { item: ChestResult['cosmetic'] }) {
  if (item.slot === 'plate') {
    return <span className="chest__plate" style={{ background: item.value }} aria-hidden="true" />;
  }
  return (
    <span className="chest__badge" aria-hidden="true">
      {item.value}
    </span>
  );
}
