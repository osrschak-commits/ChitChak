import { useCallback, useState, type MouseEvent, type ReactNode } from 'react';
import { MemberMenu } from '../components/MemberMenu.js';
import { ProfileCard } from '../components/ProfileCard.js';

/**
 * The two things a person's name can open, and the rule for which.
 *
 *   left click  -> profile card, for reading
 *   right click -> moderation menu, for acting
 *
 * Shared rather than reimplemented per surface so the gesture means the same
 * thing in the call, the sidebar and the chat log. Each hands off to the other:
 * the card offers "Moderation actions", the menu offers "View profile", so
 * nobody is stuck with the wrong one open.
 */
type Popover = { kind: 'card' | 'menu'; userId: string; x: number; y: number };

export function usePersonPopover(
  guildId: string | null,
  options: { onEditProfile?(): void } = {},
): {
  bind(userId: string): {
    onClick(event: MouseEvent): void;
    onContextMenu(event: MouseEvent): void;
  };
  /** Right-click only, for surfaces where left click already does something. */
  bindMenuOnly(userId: string): { onContextMenu(event: MouseEvent): void };
  popovers: ReactNode;
} {
  const [popover, setPopover] = useState<Popover | null>(null);

  const open = useCallback((kind: 'card' | 'menu', userId: string, event: MouseEvent) => {
    event.preventDefault();
    // Without this, clicking a name inside a clickable tile would also trigger
    // the tile.
    event.stopPropagation();
    setPopover({ kind, userId, x: event.clientX, y: event.clientY });
  }, []);

  const bind = useCallback(
    (userId: string) => ({
      onClick: (event: MouseEvent) => open('card', userId, event),
      onContextMenu: (event: MouseEvent) => open('menu', userId, event),
    }),
    [open],
  );

  const bindMenuOnly = useCallback(
    (userId: string) => ({
      onContextMenu: (event: MouseEvent) => open('menu', userId, event),
    }),
    [open],
  );

  const close = useCallback(() => setPopover(null), []);

  let popovers: ReactNode = null;
  if (popover && guildId) {
    const shared = { guildId, userId: popover.userId, x: popover.x, y: popover.y, onClose: close };
    popovers =
      popover.kind === 'card' ? (
        <ProfileCard
          {...shared}
          {...(options.onEditProfile ? { onEditProfile: options.onEditProfile } : {})}
          onModerate={() => setPopover({ ...popover, kind: 'menu' })}
        />
      ) : (
        <MemberMenu
          {...shared}
          {...(options.onEditProfile ? { onEditProfile: options.onEditProfile } : {})}
          onViewProfile={() => setPopover({ ...popover, kind: 'card' })}
        />
      );
  }

  return { bind, bindMenuOnly, popovers };
}
