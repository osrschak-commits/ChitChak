import { useState } from 'react';
import type { Rank } from '@chitchak/protocol';
import { PERMISSION_GROUPS, Permission, has } from '@chitchak/protocol';
import { api } from '../lib/api.js';
import { usePermissions, useRanks } from '../hooks/usePermissions.js';
import { Switch } from './primitives.js';

const RANK_COLORS = [
  '#d9a45b',
  '#4fd6c4',
  '#8a7fd4',
  '#d97b6c',
  '#6ca9d9',
  '#b0c05f',
  '#d48fb8',
  '#9aa3ad',
];

/**
 * Rank management.
 *
 * The two hard rules are visible in the UI as well as enforced on the server:
 * you cannot touch a rank at or above your own, and you cannot grant a
 * permission you do not hold.
 */
export function RanksTab({ guildId }: { guildId: string }) {
  const ranks = useRanks();
  const { self } = usePermissions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = ranks.find((r) => r.id === selectedId) ?? ranks[0] ?? null;
  const canEdit = (rank: Rank) => self.isOwner || rank.position < self.position;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const rank = await api.createRank(guildId, { name: 'New rank', permissions: 0 });
      setSelectedId(rank.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that rank');
    } finally {
      setBusy(false);
    }
  }

  async function move(rank: Rank, direction: -1 | 1) {
    // The list is most-senior-first, so moving "up" the list means a higher
    // position. The default rank is pinned to the bottom and never reorders.
    const movable = ranks.filter((r) => !r.isDefault);
    const index = movable.findIndex((r) => r.id === rank.id);
    const target = index + direction;
    if (target < 0 || target >= movable.length) return;

    const reordered = [...movable];
    const [removed] = reordered.splice(index, 1);
    if (removed) reordered.splice(target, 0, removed);

    setError(null);
    try {
      await api.reorderRanks(
        guildId,
        reordered.map((r) => r.id),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reorder ranks');
    }
  }

  return (
    <>
      {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}

      <div className="ranks">
        <div className="ranks__list">
          <div className="group__header" style={{ padding: '0 0 8px' }}>
            <span className="legend">{ranks.length} ranks</span>
            <button className="linkish" style={{ fontSize: 11 }} disabled={busy} onClick={() => void create()}>
              + New
            </button>
          </div>

          {ranks.map((rank, index) => (
            <div key={rank.id} className="ranks__row">
              <button
                className={`ranks__item ${selected?.id === rank.id ? 'ranks__item--active' : ''}`}
                onClick={() => setSelectedId(rank.id)}
              >
                <span
                  className="ranks__dot"
                  style={{ background: rank.color ?? 'var(--graphite-600)' }}
                />
                <span className="chan__name">{rank.name}</span>
                {rank.isDefault && <span className="legend">default</span>}
              </button>
              {!rank.isDefault && canEdit(rank) && (
                <span className="list__actions">
                  <button
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    disabled={index === 0}
                    onClick={() => void move(rank, -1)}
                    title="Promote"
                  >
                    ↑
                  </button>
                  <button
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    onClick={() => void move(rank, 1)}
                    title="Demote"
                  >
                    ↓
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="ranks__editor">
          {selected ? (
            <RankEditor
              key={selected.id}
              rank={selected}
              editable={canEdit(selected)}
              actorPermissions={self.permissions}
              isOwner={self.isOwner}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <p className="empty__body">No ranks yet.</p>
          )}
        </div>
      </div>
    </>
  );
}

function RankEditor({
  rank,
  editable,
  actorPermissions,
  isOwner,
  onDeleted,
}: {
  rank: Rank;
  editable: boolean;
  actorPermissions: number;
  isOwner: boolean;
  onDeleted(): void;
}) {
  const [name, setName] = useState(rank.name);
  const [color, setColor] = useState<string | null>(rank.color);
  const [permissions, setPermissions] = useState(rank.permissions);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = name !== rank.name || color !== rank.color || permissions !== rank.permissions;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateRank(rank.id, { name: name.trim(), color, permissions });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that rank');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteRank(rank.id);
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete that rank');
      setBusy(false);
    }
  }

  function toggle(bit: number, on: boolean) {
    setPermissions((current) => (on ? current | bit : current & ~bit));
  }

  return (
    <>
      {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}

      {!editable && (
        <div className="notice" style={{ margin: '0 0 16px', background: 'var(--graphite-750)', borderColor: 'var(--line-strong)', color: 'var(--text-secondary)' }}>
          This rank is at or above your own, so you can only look at it.
        </div>
      )}

      <div className="section">
        <h3 className="section__title">Identity</h3>
        <div className="field">
          <label className="field__label" htmlFor="rank-name">
            Name
          </label>
          <input
            id="rank-name"
            value={name}
            maxLength={32}
            disabled={!editable || rank.isDefault}
            onChange={(e) => setName(e.target.value)}
          />
          {rank.isDefault && (
            <div className="field__hint">
              Everyone holds this rank. It sets the baseline for the whole server.
            </div>
          )}
        </div>

        <div className="row">
          <div>
            <div className="row__label">Colour</div>
            <div className="row__hint">Colours the names of everyone holding it.</div>
          </div>
          <div className="swatches row__control">
            <button
              className="swatch"
              style={{ background: 'var(--graphite-600)' }}
              aria-pressed={color === null}
              aria-label="No colour"
              disabled={!editable}
              onClick={() => setColor(null)}
            />
            {RANK_COLORS.map((value) => (
              <button
                key={value}
                className="swatch"
                style={{ background: value }}
                aria-pressed={color === value}
                aria-label={`Colour ${value}`}
                disabled={!editable}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
        </div>
      </div>

      {PERMISSION_GROUPS.map((group) => (
        <div className="section" key={group.label}>
          <h3 className="section__title">{group.label}</h3>
          {group.permissions.map(({ key, label, description }) => {
            const bit = Permission[key];
            const held = (permissions & bit) !== 0;
            // You cannot grant what you do not hold - the server refuses, so
            // the control is disabled rather than failing on save.
            const grantable = isOwner || has(actorPermissions, bit);
            return (
              <div className="row" key={key}>
                <div>
                  <div className="row__label">{label}</div>
                  <div className="row__hint">
                    {description}
                    {!grantable && !held && ' You do not have this permission yourself.'}
                  </div>
                </div>
                <Switch
                  label={label}
                  checked={held}
                  onChange={(next) => toggle(bit, next)}
                  disabled={!editable || (!grantable && !held)}
                />
              </div>
            );
          })}
        </div>
      ))}

      {editable && (
        <div className="modal__foot" style={{ padding: '14px 0 0', borderTop: '1px solid var(--line)' }}>
          {!rank.isDefault && (
            <button
              className="btn btn--danger btn--sm"
              style={{ marginRight: 'auto' }}
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete rank
            </button>
          )}
          <button className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save rank'}
          </button>
        </div>
      )}
    </>
  );
}
