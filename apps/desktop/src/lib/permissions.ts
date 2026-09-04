import type { ChannelOverwrite, Guild, GuildMember, Rank } from '@chitchak/protocol';
import { ALL_PERMISSIONS, Permission, applyOverwrites, has } from '@chitchak/protocol';

/**
 * Client-side permission resolution, mirroring the server's.
 *
 * This decides what the interface offers, never what is allowed: every action
 * is checked again on the server. Hiding a button the user cannot use is a
 * courtesy; the server is the boundary.
 */

export interface ResolvedMember {
  permissions: number;
  position: number;
  isOwner: boolean;
  /** Colour of the highest-positioned rank that sets one. */
  color: string | null;
}

export function resolveMember(
  guild: Guild | undefined,
  member: GuildMember | undefined,
  ranks: Rank[],
): ResolvedMember {
  if (!guild || !member) {
    return { permissions: 0, position: 0, isOwner: false, color: null };
  }

  if (guild.ownerId === member.userId) {
    return {
      permissions: ALL_PERMISSIONS,
      position: Number.MAX_SAFE_INTEGER,
      isOwner: true,
      color: highestColor(member, ranks),
    };
  }

  const guildRanks = ranks.filter((r) => r.guildId === guild.id);
  const held = guildRanks.filter((r) => member.rankIds.includes(r.id) || r.isDefault);

  return {
    permissions: held.reduce((acc, rank) => acc | rank.permissions, 0),
    position: held.reduce((acc, rank) => Math.max(acc, rank.position), 0),
    isOwner: false,
    color: highestColor(member, ranks),
  };
}

/**
 * A member's name colour comes from the highest rank that actually sets one,
 * so a senior rank with no colour does not blank out a junior coloured one.
 */
function highestColor(member: GuildMember, ranks: Rank[]): string | null {
  const coloured = ranks
    .filter((r) => r.color && (member.rankIds.includes(r.id) || r.isDefault))
    .sort((a, b) => b.position - a.position);
  return coloured[0]?.color ?? null;
}

/** Permissions in one channel, with its overwrites applied. */
export function resolveChannel(
  resolved: ResolvedMember,
  member: GuildMember | undefined,
  channelId: string,
  ranks: Rank[],
  overwrites: ChannelOverwrite[],
): number {
  if (resolved.isOwner || has(resolved.permissions, Permission.ADMINISTRATOR)) {
    return ALL_PERMISSIONS;
  }
  if (!member) return 0;

  const relevant = new Set(
    ranks.filter((r) => member.rankIds.includes(r.id) || r.isDefault).map((r) => r.id),
  );

  return applyOverwrites(
    resolved.permissions,
    overwrites.filter((o) => o.channelId === channelId && relevant.has(o.rankId)),
  );
}

/** True when the actor may act on the target: strictly higher, or the owner. */
export function outranks(actor: ResolvedMember, target: ResolvedMember): boolean {
  if (target.isOwner) return false;
  if (actor.isOwner) return true;
  return actor.position > target.position;
}
