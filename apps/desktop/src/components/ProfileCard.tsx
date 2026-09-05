import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { mediaUrl } from '../lib/api.js';
import { outranks } from '../lib/permissions.js';
import { usePermissions, useRanks } from '../hooks/usePermissions.js';
import { fallbackAccent, useApp } from '../store/app.js';
import { Meter } from './primitives.js';

/**
 * A person, as a spec plate.
 *
 * Deliberately not the social-network profile shape - banner, round avatar
 * overlapping it, biography beneath. That layout belongs to the app this one is
 * trying not to be, and it puts decoration where the useful facts should go.
 *
 * This reads like the label on a piece of equipment: a square portrait, a
 * signal rail down the edge, and the facts in a fixed label/value grid with
 * monospace keys. Everything is scannable in the same place every time, which
 * is what you want when you are checking who somebody is mid-conversation.
 */
const STATUS_TEXT: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline',
};

export function ProfileCard({
  guildId,
  userId,
  x,
  y,
  onClose,
  onEditProfile,
  onModerate,
}: {
  guildId: string;
  userId: string;
  x: number;
  y: number;
  onClose(): void;
  onEditProfile?(): void;
  /** Opens the moderation menu for this person, when the viewer may act. */
  onModerate?(): void;
}) {
  const members = useApp((s) => s.members);
  const channels = useApp((s) => s.channels);
  const voiceStates = useApp((s) => s.voiceStates);
  const presences = useApp((s) => s.presences);
  const speaking = useApp((s) => s.speaking);
  const levels = useApp((s) => s.levels);
  const selfId = useApp((s) => s.user?.id);
  const ranks = useRanks();
  const { self, resolve } = usePermissions();

  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  const member = members.get(`${guildId}:${userId}`);
  const state = voiceStates.get(userId);
  const target = resolve(userId);
  const isSelf = userId === selfId;
  const actionable = !isSelf && outranks(self, target);

  // Flip rather than clamp when it would overhang: a card pinned half off the
  // edge is unreadable, whereas a flipped one is simply on the other side.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const margin = 10;
    setPosition({
      x: Math.max(margin, x + rect.width + margin > window.innerWidth ? x - rect.width : x),
      y: Math.max(margin, y + rect.height + margin > window.innerHeight ? y - rect.height : y),
    });
  }, [x, y]);

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

  const held = ranks.filter((r) => member.rankIds.includes(r.id));
  const status = presences.get(userId) ?? 'offline';
  const displayName = member.nickname ?? member.user.displayName;
  const accent = target.color ?? member.user.accentColor ?? fallbackAccent(userId);
  const avatar = mediaUrl(member.user.avatarUrl);
  // channelId is nullable on a voice state that is being torn down.
  const room = state?.channelId ? channels.get(state.channelId) : undefined;
  const isSpeaking = speaking.has(userId) && !state?.selfMuted;

  return (
    <div
      className="plate"
      ref={ref}
      style={{ left: position.x, top: position.y }}
      role="dialog"
      aria-label={`Profile for ${displayName}`}
    >
      {/* The rail carries their colour, the same device the room cards use. */}
      <span className="plate__rail" style={{ background: accent }} />

      <div className="plate__head">
        <span
          className="plate__portrait"
          style={{ background: avatar ? 'var(--graphite-900)' : accent }}
        >
          {avatar ? (
            <img src={avatar} alt="" draggable={false} />
          ) : (
            <span className="plate__initial">{displayName[0]?.toUpperCase()}</span>
          )}
        </span>

        <div className="plate__titles">
          <div className="plate__name" style={target.color ? { color: target.color } : undefined}>
            {displayName}
          </div>
          <div className="plate__handle mono">@{member.user.username}</div>
          <div className="plate__live">
            <span className={`plate__dot plate__dot--${status}`} />
            <span className="plate__status">{STATUS_TEXT[status] ?? 'Offline'}</span>
            {state && <Meter level={isSpeaking ? (levels.get(userId) ?? 0) : 0} />}
          </div>
        </div>
      </div>

      <dl className="plate__fields">
        <div className="plate__field">
          <dt className="legend">Ranks</dt>
          <dd>
            {held.length > 0 ? (
              <span className="plate__ranks">
                {held.map((rank) => (
                  <span key={rank.id} className="plate__rank">
                    <span
                      className="ranks__dot"
                      style={{ background: rank.color ?? 'var(--graphite-600)' }}
                    />
                    {rank.name}
                  </span>
                ))}
              </span>
            ) : (
              <span className="plate__dim">Default only</span>
            )}
          </dd>
        </div>

        <div className="plate__field">
          <dt className="legend">Joined</dt>
          <dd className="mono">
            {new Date(member.joinedAt)
              .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
              .toUpperCase()}
          </dd>
        </div>

        <div className="plate__field">
          <dt className="legend">Voice</dt>
          <dd>
            {room ? (
              <span className="plate__inroom">
                {room.name}
                {state?.serverMuted && <span className="plate__flag">server muted</span>}
                {state?.serverDeafened && <span className="plate__flag">deafened</span>}
              </span>
            ) : (
              <span className="plate__dim">Not in a room</span>
            )}
          </dd>
        </div>

        {member.nickname && (
          <div className="plate__field">
            <dt className="legend">Account</dt>
            <dd className="plate__dim">{member.user.displayName}</dd>
          </div>
        )}
      </dl>

      {member.user.bio && (
        <div className="plate__about">
          <span className="legend">About</span>
          <p>{member.user.bio}</p>
        </div>
      )}

      {(isSelf && onEditProfile) || (actionable && onModerate) ? (
        <div className="plate__foot">
          {isSelf && onEditProfile && (
            <button
              className="btn btn--ghost btn--block btn--sm"
              onClick={() => {
                onClose();
                onEditProfile();
              }}
            >
              Edit your profile
            </button>
          )}
          {actionable && onModerate && (
            <button
              className="btn btn--ghost btn--block btn--sm"
              onClick={() => {
                onClose();
                onModerate();
              }}
            >
              Moderation actions
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
