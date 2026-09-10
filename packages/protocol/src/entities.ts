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
  /**
   * Null for a direct message, which is a text channel belonging to no guild.
   * Clients decide how to render a channel from this: a DM is titled by the
   * other person, and has no topic, position or permissions of its own.
   */
  guildId: Snowflake | null;
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

/**
 * A picture a server can use as an emoji.
 *
 * Written in a message as `:name:` and left that way. The client swaps it for
 * the image when it draws, which keeps the message readable everywhere it is
 * not resolved - a search result, a notification, a database row - and means an
 * emoji that is later deleted degrades to the word somebody typed rather than
 * to a broken image.
 *
 * `url` is unsigned and stable, like an avatar rather than like an attachment.
 * These are decoration shown to everyone in the server and cached hard by the
 * browser; a link that expires would mean every emoji in a long channel
 * reloading itself daily.
 */
export interface Emoji {
  id: Snowflake;
  guildId: Snowflake;
  /** Lowercase letters, digits and underscores. What goes between the colons. */
  name: string;
  url: string;
  /** Who added it. */
  creatorId: Snowflake;
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

/**
 * A file sent with a message.
 *
 * `url` is signed and expires, because it goes straight into an `<img src>`
 * which cannot carry an Authorization header - so the URL has to be the
 * credential. It is minted when the message is serialised, which means a
 * message held in a client for longer than the link's life needs refetching
 * rather than the link being permanent.
 */
export interface Attachment {
  id: Snowflake;
  name: string;
  /** Sniffed from the bytes on upload, never what the client declared. */
  mimeType: string;
  bytes: number;
  /** Images only, so the client can reserve the space before it loads. */
  width: number | null;
  height: number | null;
  url: string;
}

export interface Message {
  id: Snowflake;
  channelId: Snowflake;
  authorId: Snowflake;
  /**
   * The words as typed, except that a picked `@name` is stored as `<@id>`.
   *
   * The client resolves `<@id>` to the person's current name at draw time, the
   * same way `:emoji:` is resolved - so a mention keeps working when someone
   * changes their display name, and degrades to `@unknown` rather than a broken
   * token when the account is gone.
   */
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: Attachment[];
  /**
   * Ids of everyone this message mentions, de-duplicated. Derived on the server
   * from the `<@id>` tokens in `content`, filtered to people who can actually
   * see the channel - so the client can trust it without re-checking.
   */
  mentions: Snowflake[];
}

/**
 * One entry in the notifications inbox: a DM that arrived, or a message that
 * mentioned you.
 *
 * A row per event rather than a per-channel counter, because the inbox shows
 * the individual things - who, where, a snippet - and "mark this one read"
 * needs something to point at. `readAt` is null until it is opened or dismissed.
 */
export interface Notification {
  id: Snowflake;
  kind: 'dm' | 'mention';
  /** The message that caused it. Gone from the inbox if that message is deleted. */
  messageId: Snowflake;
  channelId: Snowflake;
  /** Null for a DM, set for a mention in a guild channel - the context to show. */
  guildId: Snowflake | null;
  /** Who sent the message. */
  authorId: Snowflake;
  /** A short plain-text preview of the message, mentions already resolved. */
  preview: string;
  createdAt: string;
  readAt: string | null;
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
