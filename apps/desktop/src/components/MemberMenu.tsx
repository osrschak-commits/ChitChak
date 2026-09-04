import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Permission } from '@chitchak/protocol';
import { api } from '../lib/api.js';
import { outranks } from '../lib/permissions.js';
import { usePermissions, useRanks } from '../hooks/usePermissions.js';
import { useApp } from '../store/app.js';

/**
 * Right-click menu: things you can do *to* someone.
 *
 * Kept separate from the profile card on purpose. Left-click asks "who is
 * this?", right-click asks "what can I do about them?" - and a menu that
 * answers both makes the destructive half easy to hit by accident.
 *
 * Every entry is gated by permission and by hierarchy, so the menu only ever
 * offers what will actually succeed. The server checks all of it again.
 */
export function MemberMenu({
  guildId,
  userId,
  x,
  y,
  onClose,
  onViewProfile,
  onEditProfile,
}: {
  guildId: string;
  userId: string;
  x: number;
  y: number;
  onClose(): void;
  onViewProfile?(): void;
  onEditProfile?(): void;
}) {
  const members = useApp((s) => s.members);
  const channels = useApp((s) => s.channels);
  const voiceStates = useApp((s) => s.voiceStates);
  const selfId = useApp((s) => s.user?.id);
  const ranks = useRanks();
  const { self, can, resolve } = usePermissions();

  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const [submenu, setSubmenu] = useState<'none' | 'ranks' | 'move'>('none');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const member = members.get(`${guildId}:${userId}`);
  const state = voiceStates.get(userId);
  const target = resolve(userId);
  const isSelf = userId === selfId;
  const actionable = !isSelf && outranks(self, target);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)),
    });
  }, [x, y, submenu]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  if (!member) return null;

  const displayName = member.nickname ?? member.user.displayName;
  const assignableRanks = ranks.filter(
    (rank) => !rank.isDefault && (self.isOwner || rank.position < self.position),
  );
  const voiceChannels = [...channels.values()]
    .filter((c) => c.guildId === guildId && c.kind === 'voice' && c.id !== state?.channelId)
    .sort((a, b) => a.position - b.position);

  const canGrantRanks = can(Permission.MANAGE_RANKS) && actionable && assignableRanks.length > 0;
  const canMuteThem = can(Permission.MUTE_MEMBERS) && actionable && Boolean(state);
  const canMoveThem = can(Permission.MOVE_MEMBERS) && actionable && Boolean(state);
  const canKickThem = can(Permission.KICK_MEMBERS) && actionable;
  const canBanThem = can(Permission.BAN_MEMBERS) && actionable;
  const hasAnyAction = canGrantRanks || canMuteThem || canMoveThem || canKickThem || canBanThem;

  async function act(action: () => Promise<unknown>, failure: string, close = true) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (close) onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
    } finally {
      setBusy(false);
    }
  }

  function toggleRank(rankId: string) {
    const next = member!.rankIds.includes(rankId)
      ? member!.rankIds.filter((id) => id !== rankId)
      : [...member!.rankIds, rankId];
    // The menu stays open: assigning several ranks in a row is the common case.
    void act(() => api.setMemberRanks(guildId, userId, next), 'Could not change their ranks', false);
  }

  return (
    <div className="menu" ref={ref} style={{ left: position.x, top: position.y }} role="menu">
      <div className="menu__label legend">{displayName}</div>

      {error && <div className="menu__error">{error}</div>}

      {onViewProfile && (
        <button
          className="menu__item"
          onClick={() => {
            onClose();
            onViewProfile();
          }}
        >
          View profile
        </button>
      )}

      {isSelf && onEditProfile && (
        <button
          className="menu__item"
          onClick={() => {
            onClose();
            onEditProfile();
          }}
        >
          Edit your profile
        </button>
      )}

      {onViewProfile && hasAnyAction && <div className="menu__divider" />}

      {canGrantRanks && (
        <>
          <button className="menu__item" onClick={() => setSubmenu(submenu === 'ranks' ? 'none' : 'ranks')}>
            <span>Give rank</span>
            <span className="menu__chevron">{submenu === 'ranks' ? '▾' : '▸'}</span>
          </button>
          {submenu === 'ranks' && (
            <div className="menu__submenu">
              {assignableRanks.map((rank) => {
                const held = member.rankIds.includes(rank.id);
                return (
                  <button
                    key={rank.id}
                    className="menu__item"
                    disabled={busy}
                    onClick={() => toggleRank(rank.id)}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        className="ranks__dot"
                        style={{ background: rank.color ?? 'var(--graphite-600)' }}
                      />
                      {rank.name}
                    </span>
                    <span className="menu__check">{held ? '✓' : ''}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {canMuteThem && state && (
        <button
          className="menu__item"
          disabled={busy}
          onClick={() =>
            void act(
              () => api.moderateVoice(guildId, userId, { serverMuted: !state.serverMuted }),
              'Could not change their mute',
            )
          }
        >
          {state.serverMuted ? 'Unmute' : 'Server mute'}
        </button>
      )}

      {canMuteThem && state && (
        <button
          className="menu__item"
          disabled={busy}
          onClick={() =>
            void act(
              () => api.moderateVoice(guildId, userId, { serverDeafened: !state.serverDeafened }),
              'Could not change their deafen',
            )
          }
        >
          {state.serverDeafened ? 'Undeafen' : 'Server deafen'}
        </button>
      )}

      {canMoveThem && voiceChannels.length > 0 && (
        <>
          <button className="menu__item" onClick={() => setSubmenu(submenu === 'move' ? 'none' : 'move')}>
            <span>Move to</span>
            <span className="menu__chevron">{submenu === 'move' ? '▾' : '▸'}</span>
          </button>
          {submenu === 'move' && (
            <div className="menu__submenu">
              {voiceChannels.map((channel) => (
                <button
                  key={channel.id}
                  className="menu__item"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api.moderateVoice(guildId, userId, { channelId: channel.id }),
                      'Could not move them',
                    )
                  }
                >
                  {channel.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {canMoveThem && (
        <button
          className="menu__item menu__item--danger"
          disabled={busy}
          onClick={() =>
            void act(
              () => api.moderateVoice(guildId, userId, { channelId: null }),
              'Could not disconnect them',
            )
          }
        >
          Disconnect from voice
        </button>
      )}

      {(canKickThem || canBanThem) && <div className="menu__divider" />}

      {canKickThem && (
        <button
          className="menu__item menu__item--danger"
          disabled={busy}
          onClick={() => void act(() => api.kickMember(guildId, userId), 'Could not remove them')}
        >
          Kick from server
        </button>
      )}

      {canBanThem && (
        <button
          className="menu__item menu__item--danger"
          disabled={busy}
          onClick={() =>
            void act(
              () => api.banMember(guildId, userId, { reason: null }),
              'Could not ban them',
            )
          }
        >
          Ban from server
        </button>
      )}

      {/*
        An empty menu reads as broken. Say why it is empty instead: the three
        reasons are being yourself, being outranked, and the target not being in
        a voice room - and each needs a different thing from the reader.
      */}
      {!hasAnyAction && (
        <>
          {onViewProfile && <div className="menu__divider" />}
          <div className="menu__note">
            {isSelf
              ? 'This is you. Moderation actions appear when you right-click someone else.'
              : target.isOwner
                ? 'They own this server, so nobody can moderate them.'
                : self.position <= target.position && !self.isOwner
                  ? 'They rank at or above you, so you cannot moderate them.'
                  : 'You do not have permission to moderate anyone here.'}
          </div>
        </>
      )}

      {/* Voice actions are conditional on where they are, which is not obvious
          from their absence. */}
      {hasAnyAction && !state && actionable && can(Permission.MUTE_MEMBERS) && (
        <div className="menu__note">Mute, deafen and move appear once they join a room.</div>
      )}
    </div>
  );
}
