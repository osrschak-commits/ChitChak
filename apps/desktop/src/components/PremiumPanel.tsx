import { useEffect, useState } from 'react';
import { api, type CosmeticItem, type PremiumState } from '../lib/api.js';

/**
 * Brass, and the shop it comes with.
 *
 * Sits in your profile beside the level panel, because both answer "what have I
 * got" and neither is a place you go on purpose - you arrive while looking at
 * something else, which is the right amount of prominence for a shop in an app
 * whose point is talking to people.
 *
 * Everything here is decoration. That is deliberate and worth saying out loud
 * in the interface, not just in the code: an app where money buys authority
 * over other people is a different app.
 */

const SLOT_NAMES: Record<string, string> = {
  plate: 'Plates',
  badge: 'Badges',
};

const SLOT_BLURBS: Record<string, string> = {
  plate: 'The finish on your profile card.',
  badge: 'A small mark beside your name.',
};

export function PremiumPanel() {
  const [state, setState] = useState<PremiumState | null>(null);
  const [store, setStore] = useState<{ open: boolean; packs: Array<{ id: string; keys: number | null }> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .premium()
      .then((next) => live && setState(next))
      .catch(() => live && setError('Could not load the store.'));
    void api
      .premiumStore()
      .then((next) => live && setStore(next))
      .catch(() => live && setStore({ open: false, packs: [] }));
    return () => {
      live = false;
    };
  }, []);

  /**
   * Pay in a real browser, not in here.
   *
   * `window.open` reaches Electron's window-open handler, which hands the URL
   * to the system browser. Somebody typing a card number should be able to see
   * the address bar, and an app window cannot honestly offer one.
   */
  async function openCheckout(pack: string) {
    setBusy(pack);
    setError(null);
    try {
      const { url } = await api.checkout(pack);
      window.open(url, '_blank', 'noopener');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not open the checkout');
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setState(await api.premium());
  }

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await run();
      await refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }

  if (error && !state) return <div className="section"><div className="notice">{error}</div></div>;
  if (!state) return <div className="section"><p className="empty__body">Loading…</p></div>;

  const slots = [...new Set(state.items.map((item) => item.slot))];

  return (
    <>
      <div className="section">
        <h3 className="section__title">Brass</h3>

        <div className="brass">
          <div className="brass__keys">
            <span className="brass__count mono">{state.keys}</span>
            <span className="brass__unit">chak {state.keys === 1 ? 'key' : 'keys'}</span>
          </div>

          <div className="brass__status">
            {state.subscription.active ? (
              <>
                <span className="brass__badge mono">Subscribed</span>
                <span className="row__hint">
                  {state.keysPerPeriod} keys each period
                  {state.subscription.renewsAt &&
                    ` · renews ${new Date(state.subscription.renewsAt).toLocaleDateString([], {
                      day: 'numeric',
                      month: 'long',
                    })}`}
                </span>
              </>
            ) : (
              <>
                <span className="brass__badge brass__badge--off mono">Not subscribed</span>
                <span className="row__hint">
                  {store?.open
                    ? `Brass gets you ${state.keysPerPeriod} keys a period.`
                    : /* Honest about the state of it rather than a button that
                         goes nowhere. A "Subscribe" that does nothing is worse
                         than none. */
                      'Subscribing is not open yet.'}
                </span>
              </>
            )}
          </div>
        </div>

        {store?.open && (
          <div className="brass__buy">
            {!state.subscription.active && store.packs.some((p) => p.id === 'subscription') && (
              <button
                className="btn btn--primary btn--sm"
                disabled={busy === 'subscription'}
                onClick={() => void openCheckout('subscription')}
              >
                {busy === 'subscription' ? 'Opening…' : 'Subscribe'}
              </button>
            )}

            {store.packs
              .filter((pack) => pack.keys !== null)
              .map((pack) => (
                <button
                  key={pack.id}
                  className="btn btn--ghost btn--sm"
                  disabled={busy === pack.id}
                  onClick={() => void openCheckout(pack.id)}
                >
                  {busy === pack.id ? 'Opening…' : `Buy ${pack.keys} keys`}
                </button>
              ))}
          </div>
        )}
      </div>

      {error && <div className="notice">{error}</div>}

      {slots.map((slot) => (
        <div className="section" key={slot}>
          <h3 className="section__title">{SLOT_NAMES[slot] ?? slot}</h3>
          <p className="row__hint" style={{ marginBottom: 12 }}>
            {SLOT_BLURBS[slot]}
          </p>

          <div className="shop">
            {state.items
              .filter((item) => item.slot === slot)
              .map((item) => (
                <ShopItem
                  key={item.id}
                  item={item}
                  busy={busy === item.id}
                  onBuy={() => void act(item.id, () => api.buyCosmetic(item.id))}
                  onWear={() =>
                    void act(item.id, () =>
                      api.equipCosmetic(item.equipped ? null : item.id, item.slot),
                    )
                  }
                />
              ))}
          </div>
        </div>
      ))}
    </>
  );
}

function ShopItem({
  item,
  busy,
  onBuy,
  onWear,
}: {
  item: CosmeticItem;
  busy: boolean;
  onBuy(): void;
  onWear(): void;
}) {
  return (
    <div className={`shopitem ${item.equipped ? 'shopitem--worn' : ''}`}>
      {/* The item shows itself rather than describing itself: a plate is its
          finish and a badge is its glyph, so the swatch is the product. */}
      <span
        className={`shopitem__swatch shopitem__swatch--${item.slot}`}
        style={item.slot === 'plate' ? { background: item.value } : undefined}
        aria-hidden="true"
      >
        {item.slot === 'badge' ? item.value : null}
      </span>

      <div className="shopitem__text">
        <span className="shopitem__name">{item.name}</span>
        <span className="shopitem__blurb">{item.blurb}</span>
      </div>

      {item.owned ? (
        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={onWear}>
          {busy ? '…' : item.equipped ? 'Take off' : 'Wear'}
        </button>
      ) : (
        <button className="btn btn--sm" disabled={busy} onClick={onBuy}>
          {busy ? '…' : `${item.price} ${item.price === 1 ? 'key' : 'keys'}`}
        </button>
      )}
    </div>
  );
}
