import { useEffect, useState } from 'react';
import type { Ban, GuildMember } from '@chitchak/protocol';
import { Permission } from '@chitchak/protocol';
import { api } from '../lib/api.js';
import { outranks } from '../lib/permissions.js';
import { usePermissions, useRanks } from '../hooks/usePermissions.js';
import { useApp } from '../store/app.js';
import { Avatar, MemberName } from './primitives.js';

/**
 * Members: who is here, what ranks they hold, and the moderation actions the
 * viewer is actually allowed to take against each of them.
 */
export function MembersTab({ guildId }: { guildId: string }) {
  const storeMembers = useApp((s) => s.members);
  const presences = useApp((s) => s.presences);
  const guild = useApp((s) => s.guilds.find((g) => g.id === guildId));
  const ranks = useRanks();
  const { self, can, resolve } = usePermissions();

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmBan, setConfirmBan] = useState<GuildMember | null>(null);

  const members = [...storeMembers.values()]
    .filter((m) => m.guildId === guildId)
    .sort((a, b) => {
      // Most senior first, then alphabetically - the order a moderator scans in.
      const pa = resolve(a.userId).position;
      const pb = resolve(b.userId).position;
      return pb - pa || (a.nickname ?? a.user.displayName).localeCompare(b.nickname ?? b.user.displayName);
    });

  async function act(action: () => Promise<unknown>, failure: string) {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
    }
  }

  return (
    <>
      {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}

      <div className="section">
        <h3 className="section__title">{members.length} members</h3>
        <div className="list">
          {members.map((member) => {
            const target = resolve(member.userId);
            const actionable = outranks(self, target);
            const held = ranks.filter((r) => member.rankIds.includes(r.id));

            return (
              <div key={member.userId} className="list__row">
                <Avatar
                  user={member.user}
                  size={30}
                  status={presences.get(member.userId) ?? 'offline'}
                />
                <div className="list__main">
                  <div className="list__name">
                    <MemberName
                      name={member.nickname ?? member.user.displayName}
                      color={target.color}
                    />
                    {member.userId === guild?.ownerId && (
                      <span className="legend" style={{ marginLeft: 8 }}>
                        owner
                      </span>
                    )}
                  </div>
                  <div className="list__meta">
                    @{member.user.username}
                    {held.length > 0 && ` · ${held.map((r) => r.name).join(', ')}`}
                  </div>
                </div>

                <div className="list__actions">
                  {can(Permission.MANAGE_RANKS) && actionable && (
                    <button className="btn btn--ghost btn--sm" onClick={() => setEditing(member.userId)}>
                      Ranks
                    </button>
                  )}
                  {can(Permission.KICK_MEMBERS) && actionable && (
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => void act(() => api.kickMember(guildId, member.userId), 'Could not remove them')}
                    >
                      Kick
                    </button>
                  )}
                  {can(Permission.BAN_MEMBERS) && actionable && (
                    <button className="btn btn--danger btn--sm" onClick={() => setConfirmBan(member)}>
                      Ban
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {editing && (
        <RankAssignDialog
          guildId={guildId}
          member={storeMembers.get(`${guildId}:${editing}`)!}
          onClose={() => setEditing(null)}
        />
      )}

      {confirmBan && (
        <BanDialog
          guildId={guildId}
          member={confirmBan}
          onClose={() => setConfirmBan(null)}
        />
      )}
    </>
  );
}

function RankAssignDialog({
  guildId,
  member,
  onClose,
}: {
  guildId: string;
  member: GuildMember;
  onClose(): void;
}) {
  const ranks = useRanks();
  const { self } = usePermissions();
  const [selected, setSelected] = useState<string[]>(member.rankIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The default rank is held by everyone and is never assignable.
  const assignable = ranks.filter((r) => !r.isDefault);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.setMemberRanks(guildId, member.userId, selected);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update their ranks');
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Ranks for {member.nickname ?? member.user.displayName}</h2>
          <p className="modal__sub">You can only assign ranks below your own.</p>
        </div>

        <div className="modal__body">
          {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}

          <div className="list">
            {assignable.map((rank) => {
              const allowed = self.isOwner || rank.position < self.position;
              const checked = selected.includes(rank.id);
              return (
                <label
                  key={rank.id}
                  className="list__row"
                  style={{ cursor: allowed ? 'pointer' : 'not-allowed', opacity: allowed ? 1 : 0.5 }}
                >
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={checked}
                    disabled={!allowed}
                    onChange={(e) =>
                      setSelected((current) =>
                        e.target.checked
                          ? [...current, rank.id]
                          : current.filter((id) => id !== rank.id),
                      )
                    }
                  />
                  <span
                    className="ranks__dot"
                    style={{ background: rank.color ?? 'var(--graphite-600)' }}
                  />
                  <span className="list__main">
                    <span className="list__name">{rank.name}</span>
                  </span>
                </label>
              );
            })}
            {assignable.length === 0 && (
              <p className="empty__body">No assignable ranks yet. Create one first.</p>
            )}
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save ranks'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BanDialog({
  guildId,
  member,
  onClose,
}: {
  guildId: string;
  member: GuildMember;
  onClose(): void;
}) {
  const [reason, setReason] = useState('');
  const [deleteMessages, setDeleteMessages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.banMember(guildId, member.userId, { reason: reason.trim() || null, deleteMessages });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not ban them');
      setBusy(false);
    }
  }

  const name = member.nickname ?? member.user.displayName;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Ban {name}?</h2>
          <p className="modal__sub">
            They are removed and cannot rejoin, even with a new invite, until the ban is lifted.
          </p>
        </div>

        <div className="modal__body">
          {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}

          <div className="field">
            <label className="field__label" htmlFor="ban-reason">
              Reason (optional)
            </label>
            <input
              id="ban-reason"
              value={reason}
              maxLength={500}
              autoFocus
              placeholder="Recorded on the ban list"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="row">
            <div>
              <div className="row__label">Also delete their recent messages</div>
              <div className="row__hint">Everything they posted in the last 24 hours.</div>
            </div>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={deleteMessages}
              onChange={(e) => setDeleteMessages(e.target.checked)}
            />
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--danger" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Banning…' : `Ban ${name}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The ban list, and the only way to lift one. */
export function BansTab({ guildId }: { guildId: string }) {
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listBans(guildId)
      .then(setBans)
      .catch(() => setError('Could not load the ban list'));
  }, [guildId]);

  async function unban(userId: string) {
    setError(null);
    try {
      await api.unbanMember(guildId, userId);
      setBans((current) => current?.filter((b) => b.userId !== userId) ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not lift that ban');
    }
  }

  return (
    <>
      {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}
      <div className="section">
        <h3 className="section__title">{bans?.length ?? 0} banned</h3>

        {bans === null && <p className="empty__body">Loading…</p>}
        {bans?.length === 0 && <p className="empty__body">Nobody is banned from this server.</p>}

        <div className="list">
          {bans?.map((ban) => (
            <div key={ban.userId} className="list__row">
              <Avatar user={ban.user} size={30} />
              <div className="list__main">
                <div className="list__name">{ban.user.displayName}</div>
                <div className="list__meta">
                  @{ban.user.username}
                  {ban.reason ? ` · ${ban.reason}` : ' · no reason given'}
                </div>
              </div>
              <button className="btn btn--ghost btn--sm" onClick={() => void unban(ban.userId)}>
                Lift ban
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
