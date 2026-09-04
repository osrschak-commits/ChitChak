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
  const members = useApp((s) => s.members);
  const user = useApp((s) => s.user);

  const [open, setOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape - a menu that can only be dismissed by
  // picking something from it is a trap.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) setOpen(false);
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

  const guild = guilds.find((g) => g.id === selectedGuildId);
  const memberCount = guild
    ? [...members.values()].filter((m) => m.guildId === guild.id).length
    : 0;

  return (
    <header className="topbar">
      <span className="wordmark">CHITCHAK</span>

      <div className="switcher" ref={switcherRef}>
        <button
          className="switcher__button"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((v) => !v)}
        >
          <GuildBadge guild={guild} size={20} />
          <span className="switcher__name">{guild?.name ?? 'No server'}</span>
          <span className="switcher__chevron" aria-hidden="true">
            ▼
          </span>
        </button>

        {open && (
          <div className="switcher__menu" role="menu">
            {guilds.map((item) => (
              <button
                key={item.id}
                role="menuitem"
                className={`switcher__item ${item.id === selectedGuildId ? 'switcher__item--active' : ''}`}
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

      {guild && (
        <span className="legend mono" title={`${memberCount} members`}>
          {memberCount} {memberCount === 1 ? 'member' : 'members'}
        </span>
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
