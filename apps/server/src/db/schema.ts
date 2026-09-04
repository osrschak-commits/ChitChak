import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Drizzle has no first-class bytea column, so map it to a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * IDs are snowflakes stored as text (see lib/ids.ts). Text rather than bigint
 * because every consumer - JSON, JavaScript, URLs - handles them as strings
 * anyway, and a bigint column invites a silent precision-losing round trip
 * through a JS number somewhere in the stack.
 */
const id = () => text('id').primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const channelKind = pgEnum('channel_kind', ['text', 'voice']);
export const presenceStatus = pgEnum('presence_status', ['online', 'idle', 'dnd', 'offline']);

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    bio: text('bio'),
    /** Hex colour for the user's avatar ring and monogram tile. */
    accentColor: text('accent_color'),
    /**
     * Bumped whenever the avatar is replaced. Appended to the avatar URL as a
     * cache-buster so a new upload is visible immediately, while the image
     * itself can still be served with a long cache lifetime.
     */
    avatarVersion: integer('avatar_version').notNull().default(0),
    createdAt: createdAt(),
    // Bumped on password change and on "log out everywhere"; any access token
    // issued before this moment is treated as invalid even though its signature
    // is still good.
    tokensValidFrom: timestamp('tokens_valid_from', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Both columns are normalised to lowercase before insert (see auth routes),
    // so a plain unique index gives case-insensitive uniqueness without needing
    // a functional index that every query would have to match exactly.
    uniqueIndex('users_email_idx').on(table.email),
    uniqueIndex('users_username_idx').on(table.username),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Rotation chain: when a token is used, it is revoked and its successor
    // recorded here. Seeing a revoked token presented again means the chain was
    // stolen, and the whole family should be dropped.
    replacedById: text('replaced_by_id'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('refresh_tokens_hash_idx').on(table.tokenHash),
    index('refresh_tokens_user_idx').on(table.userId),
  ],
);

export const guilds = pgTable('guilds', {
  id: id(),
  name: text('name').notNull(),
  iconVersion: integer('icon_version').notNull().default(0),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: createdAt(),
});

/**
 * Avatars and server icons, stored as rows.
 *
 * Deliberately not object storage: these are 256x256 images measured in tens of
 * kilobytes, and a bytea column costs nothing to back up, has no second system
 * to configure, and no signed-URL dance. It stops being the right answer at the
 * point users upload full-size media - see the note in the README.
 */
export const imageKind = pgEnum('image_kind', ['user_avatar', 'guild_icon']);

export const images = pgTable(
  'images',
  {
    kind: imageKind('kind').notNull(),
    /** User id or guild id, depending on `kind`. */
    ownerId: text('owner_id').notNull(),
    mimeType: text('mime_type').notNull(),
    data: bytea('data').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.ownerId] })],
);

export const guildMembers = pgTable(
  'guild_members',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nickname: text('nickname'),
    joinedAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index('guild_members_user_idx').on(table.userId),
  ],
);

export const channels = pgTable(
  'channels',
  {
    id: id(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: channelKind('kind').notNull(),
    topic: text('topic'),
    position: integer('position').notNull().default(0),
    /** Voice channels: 0 means unlimited. */
    userLimit: integer('user_limit').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [index('channels_guild_idx').on(table.guildId, table.position)],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: createdAt(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (table) => [
    // Covers the only read pattern that matters: newest-first history for one
    // channel, paged with a `(created_at, id) < cursor` predicate.
    //
    // Ordered by created_at rather than by id alone: ids are snowflakes stored
    // as text, and text comparison only matches numeric order while every id
    // has the same number of digits. That holds today and stops holding the
    // first time an id gains a digit, which is exactly the kind of bug that
    // surfaces years later as "old messages jumped to the top".
    index('messages_channel_created_idx').on(table.channelId, table.createdAt, table.id),
  ],
);

/**
 * Ranks: named permission bundles, ordered by `position`.
 *
 * Higher position outranks lower. A member's position is that of their highest
 * rank, and moderation actions require acting strictly downward - which is what
 * stops two moderators removing each other.
 */
export const ranks = pgTable(
  'ranks',
  {
    id: id(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    position: integer('position').notNull().default(0),
    // bigint in `number` mode: exact to 2^53, which is far more permission bits
    // than this will ever hold, and avoids BigInt at every serialisation edge.
    permissions: bigint('permissions', { mode: 'number' }).notNull().default(0),
    /** The rank every member holds implicitly. One per guild, never assignable. */
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [index('ranks_guild_idx').on(table.guildId, table.position)],
);

export const memberRanks = pgTable(
  'member_ranks',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rankId: text('rank_id')
      .notNull()
      .references(() => ranks.id, { onDelete: 'cascade' }),
    assignedAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId, table.rankId] }),
    index('member_ranks_member_idx').on(table.guildId, table.userId),
  ],
);

/**
 * Per-channel permission adjustments for a rank.
 *
 * `deny` is applied before `allow`, so granting one rank access to an otherwise
 * closed channel works the way people expect.
 */
export const channelOverwrites = pgTable(
  'channel_overwrites',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    rankId: text('rank_id')
      .notNull()
      .references(() => ranks.id, { onDelete: 'cascade' }),
    allow: bigint('allow', { mode: 'number' }).notNull().default(0),
    deny: bigint('deny', { mode: 'number' }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.rankId] })],
);

export const bans = pgTable(
  'bans',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    bannedBy: text('banned_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const invites = pgTable(
  'invites',
  {
    code: text('code').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** null = never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** 0 = unlimited. */
    maxUses: integer('max_uses').notNull().default(0),
    uses: integer('uses').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [index('invites_guild_idx').on(table.guildId)],
);

/**
 * Voice state is persisted rather than kept purely in memory so that a server
 * restart does not lose track of who the SFU still has connected, and so a
 * second API instance can answer "who is in this channel" without a broadcast.
 * Rows are deleted on leave; a row here means "currently in voice".
 */
export const voiceStates = pgTable(
  'voice_states',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    selfMuted: boolean('self_muted').notNull().default(false),
    selfDeafened: boolean('self_deafened').notNull().default(false),
    serverMuted: boolean('server_muted').notNull().default(false),
    /** Imposed by a moderator; the SFU stops forwarding audio to them. */
    serverDeafened: boolean('server_deafened').notNull().default(false),
    selfVideo: boolean('self_video').notNull().default(false),
    selfScreenShare: boolean('self_screen_share').notNull().default(false),
    joinedAt: createdAt(),
  },
  (table) => [index('voice_states_channel_idx').on(table.channelId)],
);

// --- Relations, for the query builder's `with` joins ------------------------

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(guildMembers),
  messages: many(messages),
}));

export const guildsRelations = relations(guilds, ({ many, one }) => ({
  channels: many(channels),
  members: many(guildMembers),
  owner: one(users, { fields: [guilds.ownerId], references: [users.id] }),
}));

export const guildMembersRelations = relations(guildMembers, ({ one }) => ({
  guild: one(guilds, { fields: [guildMembers.guildId], references: [guilds.id] }),
  user: one(users, { fields: [guildMembers.userId], references: [users.id] }),
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  guild: one(guilds, { fields: [channels.guildId], references: [guilds.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  channel: one(channels, { fields: [messages.channelId], references: [channels.id] }),
  author: one(users, { fields: [messages.authorId], references: [users.id] }),
}));

export const ranksRelations = relations(ranks, ({ one, many }) => ({
  guild: one(guilds, { fields: [ranks.guildId], references: [guilds.id] }),
  members: many(memberRanks),
}));

export const memberRanksRelations = relations(memberRanks, ({ one }) => ({
  rank: one(ranks, { fields: [memberRanks.rankId], references: [ranks.id] }),
  user: one(users, { fields: [memberRanks.userId], references: [users.id] }),
}));

export type UserRow = typeof users.$inferSelect;
export type GuildRow = typeof guilds.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type VoiceStateRow = typeof voiceStates.$inferSelect;
export type RankRow = typeof ranks.$inferSelect;
export type BanRow = typeof bans.$inferSelect;
