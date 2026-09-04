/**
 * Entities as they appear on the wire. These are deliberately *not* the
 * database row types - the DB may hold columns (password hashes, internal
 * flags) that must never leave the server.
 */

export type Snowflake = string;

export type ChannelKind = 'text' | 'voice';

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

export interface PublicUser {
  id: Snowflake;
  username: string;
  displayName: string;
  /**
   * Path to the avatar image, or null when the user has not set one. Carries a
   * `?v=` cache-buster so a new upload appears immediately without the client
   * having to reason about cache headers.
   */
  avatarUrl: string | null;
  bio: string | null;
  /** Hex colour chosen by the user; falls back to a hash of their id. */
  accentColor: string | null;
}

export interface SelfUser extends PublicUser {
  email: string;
  createdAt: string;
}

export interface Guild {
  id: Snowflake;
  name: string;
  iconUrl: string | null;
  ownerId: Snowflake;
}

export interface Channel {
  id: Snowflake;
  guildId: Snowflake;
  name: string;
  kind: ChannelKind;
  /** One line describing what the channel is for. Shown in its header. */
  topic: string | null;
  position: number;
  /** Voice channels only: refuse joins past this many participants. 0 = unlimited. */
  userLimit: number;
}

export interface GuildMember {
  userId: Snowflake;
  guildId: Snowflake;
  nickname: string | null;
  joinedAt: string;
  /** Ids of every rank this member holds, excluding the implicit default rank. */
  rankIds: Snowflake[];
  user: PublicUser;
}

/**
 * A named bundle of permissions with a position in the hierarchy.
 *
 * `position` orders ranks: higher outranks lower. A member's own position is
 * that of their highest rank, and you can only act on someone strictly below
 * you - which is what stops a moderator removing another moderator.
 */
export interface Rank {
  id: Snowflake;
  guildId: Snowflake;
  name: string;
  /** Hex colour, or null to inherit. The highest coloured rank colours the name. */
  color: string | null;
  position: number;
  permissions: number;
  /** The rank every member holds implicitly. Cannot be deleted or assigned. */
  isDefault: boolean;
}

/** Per-channel permission adjustment for one rank. */
export interface ChannelOverwrite {
  channelId: Snowflake;
  rankId: Snowflake;
  allow: number;
  deny: number;
}

export interface Ban {
  guildId: Snowflake;
  userId: Snowflake;
  reason: string | null;
  bannedBy: Snowflake;
  createdAt: string;
  user: PublicUser;
}

export interface Invite {
  code: string;
  guildId: Snowflake;
  createdBy: Snowflake;
  expiresAt: string | null;
  /** 0 means unlimited. */
  maxUses: number;
  uses: number;
  createdAt: string;
}

export interface Message {
  id: Snowflake;
  channelId: Snowflake;
  authorId: Snowflake;
  content: string;
  createdAt: string;
  editedAt: string | null;
}

/**
 * Where a user is in voice, and how they have configured themselves there.
 *
 * `selfMuted`/`selfDeafened` are chosen by the user; `serverMuted` is imposed by
 * a moderator and is the one the SFU actually enforces. A self-mute is honoured
 * client-side by not publishing audio, which keeps push-to-talk instant.
 *
 * `selfVideo` and `selfScreenShare` are advisory: they let other clients lay out
 * a tile before the media track actually arrives, so the grid does not jump.
 */
export interface VoiceState {
  userId: Snowflake;
  guildId: Snowflake;
  channelId: Snowflake | null;
  selfMuted: boolean;
  selfDeafened: boolean;
  serverMuted: boolean;
  /** Imposed by a moderator. The SFU stops forwarding audio to them. */
  serverDeafened: boolean;
  selfVideo: boolean;
  selfScreenShare: boolean;
}
