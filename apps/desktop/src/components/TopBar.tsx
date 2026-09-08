import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../lib/api.js';
import { useApp } from '../store/app.js';
import { Avatar } from './primitives.js';
import { UpdateBanner } from './UpdateBanner.js';

/**
 * Top bar: which of the two places you are in, and who you are.
 *
 * Two tabs, because there are two scopes - a server, or your friends and DMs -
 * and both need to show which one you are looking at. The server tab carries
 * the picker that replaces the usual column of server icons: with a handful of
 * servers a labelled menu reads better than a stack of monograms, and dropping
 * the rail gives the channel list and the call the full width.
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
  const showGuild = useApp((s) => s.showGuild);
  const scope = useApp((s) => s.scope);
  const requestCount = useApp((s) => s.incomingRequests.size);
  const members = useApp((s) => s.members);
  const user = useApp((s) => s.user);

  /** Whether the server menu is down. */
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLElement>(null);

  // Close on an outside click or Escape - a menu that can only be dismissed by
  // picking something from it is a trap.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
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

  return (
    <header className="topbar" ref={barRef}>
      {/*
        No wordmark. The app's name is on the window, in the taskbar and on the
        installer; repeating it in the corner of every screen spends the most
        valuable space in the bar telling people something they already know.
        What belongs here is where you are.
      */}
      <div className="scope-tabs">
        <div className={`scope-tab ${scope === 'guild' ? 'scope-tab--on' : ''}`}>
          {/*
            Split, because it does two things that should not share a click.
            The label is the tab - it takes you back to the server you were in.
            The chevron is the picker. Folding both into one control meant that
            returning from Friends cost a menu you did not want.
          */}
          <button
            className="scope-tab__main"
            aria-pressed={scope === 'guild'}
            title={guild ? `Back to ${guild.name}` : 'Choose a server'}
            onClick={() => {
              // With no server there is nothing to go back to, so the only
              // useful thing the label can do is offer the list.
              if (guild) {
                setOpen(false);
                showGuild();
              } else {
                setOpen((v) => !v);
              }
            }}
          >
            <GuildBadge guild={guild} size={20} />
            <span className="scope-tab__name">{guild?.name ?? 'No server'}</span>
          </button>

          <button
            className="scope-tab__more"
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label="Switch server"
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden="true">▼</span>
          </button>

          {open && (
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
                  setOpen(false);
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
                setOpen(false);
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
                setOpen(false);
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
          Friends is a tab beside the server, not an entry inside it. It is not
          a server, and burying it among them made the one surface that is
          about people the hardest of them to reach.

          The two tabs are the two places you can be, so both carry the same
          selected state - which is what a lone lit button could not say.
        */}
        <button
          className={`scope-tab ${scope === 'friends' ? 'scope-tab--on' : ''}`}
          aria-pressed={scope === 'friends'}
          onClick={() => {
            setOpen(false);
            openFriends();
          }}
        >
          <FriendsBadge size={20} />
          <span className="scope-tab__name">Friends</span>
          {/* A request nobody can see until they go looking is a request nobody
              answers. */}
          {requestCount > 0 && <span className="scope-tab__badge mono">{requestCount}</span>}
        </button>
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
