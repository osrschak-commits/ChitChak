import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../lib/api.js';
import { useApp } from '../store/app.js';
import { Avatar } from './primitives.js';
import { UpdateBanner } from './UpdateBanner.js';

/**
 * Top bar with the server switcher.
 *
 * The switcher replaces the usual column of server icons. With a handful of
 * servers a labelled menu is easier to read than a stack of monograms, and
 * removing the rail gives the channel list and the call the full width.
 */
export function TopBar({
  onCreateServer,
  onJoinServer,
  onOpenProfile,
  onOpenVoiceSettings,
}: {
  onCreateServer(): void;
  onJoinServer(): void;
  onOpenProfile(): void;
  onOpenVoiceSettings(): void;
}) {
  const guilds = useApp((s) => s.guilds);
  const selectedGuildId = useApp((s) => s.selectedGuildId);
  const selectGuild = useApp((s) => s.selectGuild);
  const openFriends = useApp((s) => s.openFriends);
  const scope = useApp((s) => s.scope);
  const requestCount = useApp((s) => s.incomingRequests.size);
  const members = useApp((s) => s.members);
  const user = useApp((s) => s.user);

  const dmChannels = useApp((s) => s.dmChannels);
  const people = useApp((s) => s.people);
  const selectDmChannel = useApp((s) => s.selectDmChannel);

  /** Which menu is down, if either. Only ever one. */
  const [open, setOpen] = useState<'servers' | 'friends' | null>(null);
  const barRef = useRef<HTMLElement>(null);

  // Close on an outside click or Escape - a menu that can only be dismissed by
  // picking something from it is a trap.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const membersVisible = useApp((s) => s.membersVisible);
  const toggleMembers = useApp((s) => s.toggleMembers);

  const guild = guilds.find((g) => g.id === selectedGuildId);
  const memberCount = guild
    ? [...members.values()].filter((m) => m.guildId === guild.id).length
    : 0;

  const friendNames = [...dmChannels]
    .map(([channelId, otherId]) => ({ channelId, person: people.get(otherId) }))
    .filter((entry) => entry.person)
    .sort((a, b) => a.person!.displayName.localeCompare(b.person!.displayName));

  return (
    <header className="topbar" ref={barRef}>
      {/*
        No wordmark. The app's name is on the window, in the taskbar and on the
        installer; repeating it in the corner of every screen spends the most
        valuable space in the bar telling people something they already know.
        What belongs here is where you are.
      */}
      <div className="switcher">
        <button
          className="switcher__button"
          aria-expanded={open === 'servers'}
          aria-haspopup="menu"
          onClick={() => setOpen((v) => (v === 'servers' ? null : 'servers'))}
        >
          <GuildBadge guild={guild} size={20} />
          <span className="switcher__name">{guild?.name ?? 'No server'}</span>
          <span className="switcher__chevron" aria-hidden="true">
            ▼
          </span>
        </button>

        {open === 'servers' && (
          <div className="switcher__menu" role="menu">
            {guilds.map((item) => (
              <button
                key={item.id}
                role="menuitem"
                className={`switcher__item ${
                  scope === 'guild' && item.id === selectedGuildId ? 'switcher__item--active' : ''
                }`}
                onClick={() => {
                  selectGuild(item.id);
                  setOpen(null);
                }}
              >
                <GuildBadge guild={item} size={24} />
                <span className="switcher__name">{item.name}</span>
              </button>
            ))}

            {guilds.length > 0 && <div className="switcher__divider" />}

            <button
              role="menuitem"
              className="switcher__item"
              onClick={() => {
                setOpen(null);
                onCreateServer();
              }}
            >
              <span style={{ width: 24, textAlign: 'center' }}>+</span>
              <span>Create a server</span>
            </button>
            <button
              role="menuitem"
              className="switcher__item"
              onClick={() => {
                setOpen(null);
                onJoinServer();
              }}
            >
              <span style={{ width: 24, textAlign: 'center' }}>→</span>
              <span>Join with an invite</span>
            </button>
          </div>
        )}
      </div>

      {/*
        Friends is its own control rather than an entry in the server menu.
        It is not a server, and burying it among them made the one surface that
        is about people the hardest of them to reach.
      */}
      <div className="switcher">
        <button
          className={`switcher__button ${scope === 'friends' ? 'switcher__button--on' : ''}`}
          aria-expanded={open === 'friends'}
          aria-haspopup="menu"
          onClick={() => setOpen((v) => (v === 'friends' ? null : 'friends'))}
        >
          <FriendsBadge size={20} />
          <span className="switcher__name">Friends</span>
          {/* On the closed button too: a request nobody can see until they go
              looking is a request nobody answers. */}
          {requestCount > 0 && <span className="switcher__badge mono">{requestCount}</span>}
          <span className="switcher__chevron" aria-hidden="true">
            ▼
          </span>
        </button>

        {open === 'friends' && (
          <div className="switcher__menu" role="menu">
            <button
              role="menuitem"
              className={`switcher__item ${scope === 'friends' ? 'switcher__item--active' : ''}`}
              onClick={() => {
                openFriends();
                setOpen(null);
              }}
            >
              <FriendsBadge size={24} />
              <span className="switcher__name">All friends</span>
              {requestCount > 0 && <span className="switcher__badge mono">{requestCount}</span>}
            </button>

            {friendNames.length > 0 && <div className="switcher__divider" />}

            {/* Straight into a conversation, rather than to a list that then
                has to be searched for the person you already had in mind. */}
            {friendNames.map(({ channelId, person }) => (
              <button
                key={channelId}
                role="menuitem"
                className="switcher__item"
                onClick={() => {
                  selectDmChannel(channelId);
                  setOpen(null);
                }}
              >
                <Avatar user={person!} size={24} />
                <span className="switcher__name">{person!.displayName}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {guild && (
        <button
          type="button"
          className="legend mono topbar__members"
          onClick={toggleMembers}
          aria-pressed={membersVisible}
          title={membersVisible ? 'Hide the member list' : 'Show the member list'}
        >
          {memberCount} {memberCount === 1 ? 'member' : 'members'}
        </button>
      )}

      <div className="topbar__spacer" />

      <UpdateBanner />

      {/* The top right is "you": your account, and the settings that follow you
          between servers. Anything server-specific lives in the sidebar. */}
      <button
        className="icon-btn"
        onClick={onOpenVoiceSettings}
        title="Voice and video settings"
        aria-label="Voice and video settings"
      >
        <GearIcon />
      </button>

      {user && (
        <button className="me" onClick={onOpenProfile} title="Your profile">
          <Avatar user={user} size={26} status="online" />
          <span className="me__name">{user.displayName}</span>
        </button>
      )}
    </header>
  );
}

function GearIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4" />
    </svg>
  );
}

/** Server icon, or its monogram when no icon has been uploaded. */
export function GuildBadge({
  guild,
  size = 24,
}: {
  guild: { id: string; name: string; iconUrl: string | null } | undefined;
  size?: number;
}) {
  if (!guild) {
    return (
      <span
        className="avatar"
        style={{ width: size, height: size, borderRadius: 6, background: 'var(--graphite-700)' }}
      />
    );
  }

  const src = mediaUrl(guild.iconUrl);
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        background: src ? 'var(--graphite-700)' : 'var(--graphite-600)',
        color: 'var(--text-bright)',
        fontSize: Math.max(9, Math.round(size * 0.4)),
      }}
    >
      {src ? <img src={src} alt="" draggable={false} /> : monogram(guild.name)}
    </span>
  );
}

function monogram(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}


/**
 * The Friends entry's mark.
 *
 * Deliberately not a server icon: Friends is not a server, and giving it a
 * lookalike badge would suggest it behaves like one.
 */
function FriendsBadge({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 6,
        background: 'var(--graphite-700)',
        color: 'var(--brass-400)',
        fontSize: Math.round(size * 0.62),
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      ◈
    </span>
  );
}
