import { useEffect, useMemo, useRef, useState } from 'react';
import type { Notification } from '@chitchak/protocol';
import { useApp } from '../store/app.js';
import { Avatar } from './primitives.js';

/**
 * The bell, and the inbox behind it.
 *
 * Two tabs because the two kinds of notification are read differently: a DM is
 * a conversation you owe someone a reply in, a mention is a single message you
 * were pulled into. Splitting them keeps a busy server's mentions from burying
 * the one DM that was waiting.
 *
 * The badge counts unread across both. Opening what a row points at clears it;
 * so does "Mark all as read". Nothing here plays a sound - the message that
 * caused the notification already did.
 */

type Tab = 'dm' | 'mention';

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function NotificationsMenu() {
  const notifications = useApp((s) => s.notifications);
  const openNotification = useApp((s) => s.openNotification);
  const markRead = useApp((s) => s.markNotificationsRead);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('dm');
  const wrapRef = useRef<HTMLDivElement>(null);

  const unreadCount = useMemo(
    () => notifications.filter((n) => n.readAt === null).length,
    [notifications],
  );

  // Close on an outside click or Escape - same rule as the server switcher.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
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

  // A DM's own list collapses to one row per conversation, newest on top; a
  // second message from the same person should not add a line.
  const dmRows = useMemo(() => {
    const seen = new Set<string>();
    return notifications
      .filter((n) => n.kind === 'dm')
      .filter((n) => (seen.has(n.channelId) ? false : (seen.add(n.channelId), true)));
  }, [notifications]);

  const mentionRows = useMemo(
    () => notifications.filter((n) => n.kind === 'mention'),
    [notifications],
  );

  const rows = tab === 'dm' ? dmRows : mentionRows;
  const dmUnread = dmRows.filter((n) => n.readAt === null).length;
  const mentionUnread = mentionRows.filter((n) => n.readAt === null).length;

  return (
    <div className="notif" ref={wrapRef}>
      <button
        className={`icon-btn ${unreadCount > 0 ? 'icon-btn--on' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        title="Notifications"
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="notif__badge mono">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notif__menu" role="menu">
          <div className="notif__tabs">
            <button
              className={`notif__tab ${tab === 'dm' ? 'notif__tab--on' : ''}`}
              aria-pressed={tab === 'dm'}
              onClick={() => setTab('dm')}
            >
              Direct messages
              {dmUnread > 0 && <span className="notif__tabcount mono">{dmUnread}</span>}
            </button>
            <button
              className={`notif__tab ${tab === 'mention' ? 'notif__tab--on' : ''}`}
              aria-pressed={tab === 'mention'}
              onClick={() => setTab('mention')}
            >
              Mentions
              {mentionUnread > 0 && <span className="notif__tabcount mono">{mentionUnread}</span>}
            </button>
          </div>

          <div className="notif__list">
            {rows.length === 0 ? (
              <p className="notif__empty">
                {tab === 'dm'
                  ? 'No direct messages waiting.'
                  : 'Nobody has mentioned you.'}
              </p>
            ) : (
              rows.map((n) => (
                <NotificationRow
                  key={n.id}
                  notification={n}
                  onOpen={() => {
                    openNotification(n);
                    setOpen(false);
                  }}
                />
              ))
            )}
          </div>

          {unreadCount > 0 && (
            <button className="notif__clear" onClick={() => markRead({ all: true })}>
              Mark all as read
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  notification,
  onOpen,
}: {
  notification: Notification;
  onOpen(): void;
}) {
  const members = useApp((s) => s.members);
  const people = useApp((s) => s.people);
  const guilds = useApp((s) => s.guilds);
  const channels = useApp((s) => s.channels);

  const member = notification.guildId
    ? members.get(`${notification.guildId}:${notification.authorId}`)
    : undefined;
  const person = people.get(notification.authorId);
  const authorProfile = member?.user ?? person;
  const authorName = member?.nickname ?? authorProfile?.displayName ?? 'Someone';

  const where = notification.guildId
    ? `${guilds.find((g) => g.id === notification.guildId)?.name ?? 'a server'} · #${
        channels.get(notification.channelId)?.name ?? 'channel'
      }`
    : 'Direct message';

  return (
    <button
      className={`notif__row ${notification.readAt === null ? 'notif__row--unread' : ''}`}
      onClick={onOpen}
    >
      <Avatar
        user={
          authorProfile ?? {
            id: notification.authorId,
            displayName: authorName,
            avatarUrl: null,
            accentColor: null,
          }
        }
        size={32}
      />
      <span className="notif__row-body">
        <span className="notif__row-head">
          <span className="notif__row-name">{authorName}</span>
          <span className="notif__row-time mono">{timeAgo(notification.createdAt)}</span>
        </span>
        <span className="notif__row-where mono">{where}</span>
        {notification.preview && <span className="notif__row-preview">{notification.preview}</span>}
      </span>
      {notification.readAt === null && <span className="notif__dot" aria-hidden="true" />}
    </button>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3a6 6 0 0 0-6 6c0 3.6-.9 5.6-1.7 6.7-.4.5 0 1.3.7 1.3h14c.7 0 1.1-.8.7-1.3C19.9 14.6 19 12.6 19 9a6 6 0 0 0-6-6Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M9.5 19a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
