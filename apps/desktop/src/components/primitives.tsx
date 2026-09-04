import type { PresenceStatus, PublicUser } from '@chitchak/protocol';
import { mediaUrl } from '../lib/api.js';
import { fallbackAccent } from '../store/app.js';

/**
 * The two pieces of visual vocabulary the whole app is built from: an avatar,
 * and a level meter. Both appear at several sizes, so they live here rather
 * than being re-implemented per screen.
 */

interface AvatarProps {
  user: Pick<PublicUser, 'id' | 'displayName' | 'avatarUrl' | 'accentColor'>;
  size?: number;
  speaking?: boolean;
  status?: PresenceStatus | undefined;
}

export function Avatar({ user, size = 28, speaking = false, status }: AvatarProps) {
  const src = mediaUrl(user.avatarUrl);
  const accent = user.accentColor ?? fallbackAccent(user.id);

  return (
    <div
      className={`avatar ${speaking ? 'avatar--speaking' : ''}`}
      style={{
        width: size,
        height: size,
        background: src ? 'var(--graphite-600)' : accent,
        fontSize: Math.max(9, Math.round(size * 0.38)),
      }}
    >
      {src ? (
        // The URL carries a version, so a replaced avatar is a different URL
        // and the browser cannot serve a stale one.
        <img src={src} alt="" draggable={false} />
      ) : (
        <span aria-hidden="true">{initials(user.displayName)}</span>
      )}
      {status && <span className={`avatar__status avatar__status--${status}`} />}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
}

/**
 * Level meter: three bars driven by the participant's real audio level.
 *
 * The bars are weighted so the middle one reacts hardest, which reads as a
 * voice rather than as a linear bar graph. Below a floor everything sits flat,
 * so room noise does not make the whole app twitch.
 */
export function Meter({ level, large = false }: { level: number; large?: boolean }) {
  const floor = 0.04;
  const active = level > floor;
  // Perceptual-ish curve: quiet speech should still visibly move the meter.
  const scaled = active ? Math.min(1, (level - floor) / 0.35) ** 0.6 : 0;
  const heights = [0.45, 1, 0.7].map((weight) => {
    const base = large ? 4 : 3;
    const max = large ? 18 : 11;
    return Math.round(base + scaled * weight * (max - base));
  });

  return (
    <div
      className={`meter ${large ? 'meter--lg' : ''} ${active ? 'meter--live' : ''}`}
      aria-hidden="true"
    >
      {heights.map((height, index) => (
        <span key={index} className="meter__bar" style={{ height }} />
      ))}
    </div>
  );
}

/** Accessible on/off switch. A checkbox would not take the styling we want. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/** A member's display name, coloured by their highest coloured rank. */
export function MemberName({
  name,
  color,
  className,
  ...rest
}: {
  name: string;
  color: string | null;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'color'>) {
  return (
    <span className={className} style={color ? { color } : undefined} {...rest}>
      {name}
    </span>
  );
}
