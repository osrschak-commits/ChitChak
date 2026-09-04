import type {
  Ban,
  Channel,
  ChannelOverwrite,
  Guild,
  Invite,
  PublicUser,
  Rank,
  SelfUser,
  VoiceState,
} from '@chitchak/protocol';
import type {
  bans,
  channelOverwrites,
  channels,
  guilds,
  invites,
  ranks,
  users,
  voiceStates,
} from '../db/schema.js';

/**
 * Row -> wire conversions.
 *
 * Every response and every gateway event goes through these, which is what
 * guarantees a password hash cannot leak by someone spreading a row into a
 * payload, and that an avatar URL is built the same way everywhere.
 */

/**
 * Avatar URLs carry the version as a query parameter.
 *
 * The image itself is served with a long cache lifetime, so without this a
 * replaced avatar would keep showing the old picture until the cache expired.
 * Bumping the version changes the URL, which is the only reliable way to
 * invalidate an image across every client at once.
 */
function avatarUrl(userId: string, version: number): string | null {
  return version > 0 ? `/api/users/${userId}/avatar?v=${version}` : null;
}

function iconUrl(guildId: string, version: number): string | null {
  return version > 0 ? `/api/guilds/${guildId}/icon?v=${version}` : null;
}

export function toPublicUser(row: typeof users.$inferSelect): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: avatarUrl(row.id, row.avatarVersion),
    bio: row.bio,
    accentColor: row.accentColor,
  };
}

export function toSelfUser(row: typeof users.$inferSelect): SelfUser {
  return {
    ...toPublicUser(row),
    email: row.email,
    createdAt: row.createdAt.toISOString(),
  };
}

/** For joined rows, where the user columns are selected alongside others. */
export function toPublicUserFields(row: {
  id: string;
  username: string;
  displayName: string;
  avatarVersion: number;
  bio: string | null;
  accentColor: string | null;
}): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: avatarUrl(row.id, row.avatarVersion),
    bio: row.bio,
    accentColor: row.accentColor,
  };
}

export function toGuild(row: typeof guilds.$inferSelect): Guild {
  return {
    id: row.id,
    name: row.name,
    iconUrl: iconUrl(row.id, row.iconVersion),
    ownerId: row.ownerId,
  };
}

export function toChannel(row: typeof channels.$inferSelect): Channel {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    kind: row.kind,
    topic: row.topic,
    position: row.position,
    userLimit: row.userLimit,
  };
}

export function toVoiceState(row: typeof voiceStates.$inferSelect): VoiceState {
  return {
    userId: row.userId,
    guildId: row.guildId,
    channelId: row.channelId,
    selfMuted: row.selfMuted,
    selfDeafened: row.selfDeafened,
    serverMuted: row.serverMuted,
    serverDeafened: row.serverDeafened,
    selfVideo: row.selfVideo,
    selfScreenShare: row.selfScreenShare,
  };
}

export function toRank(row: typeof ranks.$inferSelect): Rank {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    color: row.color,
    position: row.position,
    permissions: row.permissions,
    isDefault: row.isDefault,
  };
}

export function toOverwrite(row: typeof channelOverwrites.$inferSelect): ChannelOverwrite {
  return {
    channelId: row.channelId,
    rankId: row.rankId,
    allow: row.allow,
    deny: row.deny,
  };
}

export function toBan(row: typeof bans.$inferSelect, user: typeof users.$inferSelect): Ban {
  return {
    guildId: row.guildId,
    userId: row.userId,
    reason: row.reason,
    bannedBy: row.bannedBy,
    createdAt: row.createdAt.toISOString(),
    user: toPublicUser(user),
  };
}

export function toInvite(row: typeof invites.$inferSelect): Invite {
  return {
    code: row.code,
    guildId: row.guildId,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    maxUses: row.maxUses,
    uses: row.uses,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Channels sort by explicit position, then by name so ties are stable. */
export function compareChannels(a: Channel, b: Channel): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

/** Ranks sort most senior first, which is how every list of them is read. */
export function compareRanks(a: Rank, b: Rank): number {
  return b.position - a.position || a.name.localeCompare(b.name);
}
