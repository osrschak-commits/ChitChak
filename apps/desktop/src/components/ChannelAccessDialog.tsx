import { useMemo, useState } from 'react';
import type { Channel } from '@chitchak/protocol';
import { Permission } from '@chitchak/protocol';
import { api } from '../lib/api.js';
import { useRanks } from '../hooks/usePermissions.js';
import { useApp } from '../store/app.js';

/**
 * Who can use a channel.
 *
 * Each rank gets one of three states per permission: inherit what the rank
 * already has, explicitly allow, or explicitly deny. Three states rather than a
 * checkbox because "not set" and "denied" behave differently - a deny on one
 * rank still loses to an allow on another.
 */
type State = 'inherit' | 'allow' | 'deny';

const CHANNEL_PERMISSIONS = [
  { key: 'VIEW_CHANNEL', label: 'View channel', hint: 'Denying this hides the channel entirely.' },
  { key: 'SEND_MESSAGES', label: 'Send messages', hint: 'Write here.' },
  { key: 'CONNECT', label: 'Connect', hint: 'Join this voice room.' },
  { key: 'SPEAK', label: 'Speak', hint: 'Transmit audio here.' },
  { key: 'VIDEO', label: 'Use camera', hint: 'Turn a camera on here.' },
  { key: 'SCREEN_SHARE', label: 'Share screen', hint: 'Present here.' },
] as const;

export function ChannelAccessDialog({
  channel,
  onClose,
}: {
  channel: Channel;
  onClose(): void;
}) {
  const ranks = useRanks();
  const overwriteMap = useApp((s) => s.overwrites);
  const [selectedRankId, setSelectedRankId] = useState(ranks[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = useMemo(() => {
    const key = `${channel.id}:${selectedRankId}`;
    return overwriteMap.get(key) ?? { allow: 0, deny: 0 };
  }, [overwriteMap, channel.id, selectedRankId]);

  const relevant = CHANNEL_PERMISSIONS.filter((entry) =>
    channel.kind === 'text'
      ? entry.key === 'VIEW_CHANNEL' || entry.key === 'SEND_MESSAGES'
      : entry.key !== 'SEND_MESSAGES',
  );

  function stateOf(bit: number): State {
    if ((current.allow & bit) !== 0) return 'allow';
    if ((current.deny & bit) !== 0) return 'deny';
    return 'inherit';
  }

  async function set(bit: number, state: State) {
    if (!selectedRankId) return;
    let allow = current.allow & ~bit;
    let deny = current.deny & ~bit;
    if (state === 'allow') allow |= bit;
    if (state === 'deny') deny |= bit;

    setBusy(true);
    setError(null);
    try {
      // The server broadcasts the new set, and the store applies it - so this
      // dialog never holds its own copy that could drift.
      await api.setOverwrite(channel.id, { rankId: selectedRankId, allow, deny });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">
            Access to {channel.kind === 'text' ? '#' : ''}
            {channel.name}
          </h2>
          <p className="modal__sub">
            Adjust what each rank can do here. Anything left on Inherit uses the rank's own
            permissions.
          </p>
        </div>

        <div className="settings" style={{ minHeight: 280 }}>
          <nav className="settings__rail">
            {ranks.map((rank) => (
              <button
                key={rank.id}
                className={`settings__tab ${selectedRankId === rank.id ? 'settings__tab--active' : ''}`}
                onClick={() => setSelectedRankId(rank.id)}
              >
                <span
                  className="ranks__dot"
                  style={{ background: rank.color ?? 'var(--graphite-600)', marginRight: 8 }}
                />
                {rank.name}
              </button>
            ))}
          </nav>

          <div className="settings__panel">
            {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}

            {relevant.map((entry) => {
              const bit = Permission[entry.key];
              const state = stateOf(bit);
              return (
                <div className="row" key={entry.key}>
                  <div>
                    <div className="row__label">{entry.label}</div>
                    <div className="row__hint">{entry.hint}</div>
                  </div>
                  <div className="segmented row__control">
                    {(['deny', 'inherit', 'allow'] as State[]).map((option) => (
                      <button
                        key={option}
                        aria-pressed={state === option}
                        disabled={busy}
                        onClick={() => void set(bit, option)}
                      >
                        {option === 'inherit' ? 'Inherit' : option === 'allow' ? 'Allow' : 'Deny'}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
