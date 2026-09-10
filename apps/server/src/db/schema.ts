import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
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
export const friendshipState = pgEnum('friendship_state', ['pending', 'accepted']);
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
    /**
     * Set when the account is deleted. The row itself stays, emptied of
     * everything personal.
     *
     * It has to stay: messages.authorId references it with ON DELETE CASCADE,
     * so removing the row would take every message the person ever sent with
     * it - and half of everyone else's conversations along with them. What is
     * actually erased is the personal data (see deleteAccount in
     * users.routes.ts); what remains is an authorless "Deleted User" that
     * threads can still hang from.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * Locked out by platform staff.
     *
     * Deliberately not deletion and deliberately not a guild ban: the account
     * and everything in it stays exactly as it was, and lifting the suspension
     * puts the person back with their servers, friends and history intact. It
     * is the only remedy that is reversible, which is what makes it the right
     * default for a mistake nobody can undo otherwise.
     *
     * Null means not suspended. `suspendedUntil` null while suspended means
     * indefinitely - a permanent removal is a suspension nobody has lifted,
     * rather than a separate state with its own rules.
     */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedUntil: timestamp('suspended_until', { withTimezone: true }),
    /**
     * Shown to the suspended person, not just to staff.
     *
     * An account that stops working without saying why is indistinguishable
     * from a broken one, and someone who cannot find out what they did cannot
     * stop doing it.
     */
    suspendedReason: text('suspended_reason'),
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

/**
 * Password reset tokens.
 *
 * Stored hashed, for the same reason refresh tokens are: a leaked dump should
 * not hand anyone a way into an account. Short-lived and single-use - `usedAt`
 * rather than deletion, so a link clicked twice can say "already used" instead
 * of the same "invalid or expired" as a forged one.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('password_resets_hash_idx').on(table.tokenHash),
    index('password_resets_user_idx').on(table.userId),
  ],
);

/**
 * Friendship, as one row per pair for all time.
 *
 * The ids are stored sorted - userA is always the lower - so the pair is the
 * primary key and a second row for the same two people cannot exist. That is
 * not tidiness: it is what makes the simultaneous case safe. If two people add
 * each other in the same second, both inserts race for one key, one wins, and
 * the loser's unique violation is read as "you both asked" and accepted
 * immediately. Storing a row per direction instead would leave two rows that
 * nothing keeps in agreement.
 *
 * The cost is that queries cannot say `where userId = me`; they say
 * `where userA = me or userB = me`, which is why both columns are indexed.
 */
export const friendships = pgTable(
  'friendships',
  {
    userA: text('user_a')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userB: text('user_b')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: friendshipState('state').notNull(),
    /** Which of the two sent it. The only place direction is recorded. */
    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.userA, table.userB] }),
    index('friendships_a_idx').on(table.userA),
    index('friendships_b_idx').on(table.userB),
  ],
);

/**
 * Blocking, which is one-way and therefore not the same shape as friendship.
 *
 * Both people can block each other independently, so this is a row per
 * direction - the opposite of the table above, deliberately. Blocking someone
 * deletes any friendship or pending request between the two in the same
 * transaction and stops a new one being created.
 */
export const blocks = pgTable(
  'blocks',
  {
    blockerId: text('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: text('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerId, table.blockedId] }),
    index('blocks_blocked_idx').on(table.blockedId),
  ],
);

/**
 * Levelling state, one row per person.
 *
 * Its own table rather than columns on `users` for two reasons. `users` is read
 * on nearly every request and is about identity; this is written every time
 * somebody speaks, and mixing the two would put a hot write path through the
 * row that authentication reads. And a person can exist without ever having
 * earned anything - the row is created on first award, so absence means zero.
 */
export const userStats = pgTable('user_stats', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  xp: integer('xp').notNull().default(0),
  /**
   * Derived from xp, stored anyway.
   *
   * Recomputing it is trivial, but it is displayed beside names all over the
   * client and would otherwise be recomputed per row per render, and it is the
   * obvious thing to sort or filter by later.
   */
  level: integer('level').notNull().default(1),

  /** Cooldown anchor: a message earns nothing until a minute after this. */
  lastMessageXpAt: timestamp('last_message_xp_at', { withTimezone: true }),

  /** Streaks. The date is UTC, so a streak does not break on a timezone change. */
  lastActiveDate: date('last_active_date'),
  currentStreak: integer('current_streak').notNull().default(0),

  /** Voice, which nothing recorded before - see voice/xp-ticker.ts. */
  voiceSeconds: integer('voice_seconds').notNull().default(0),
  lastVoiceDate: date('last_voice_date'),
  voiceDays: integer('voice_days').notNull().default(0),
  /** One-offs cheaper to remember than to reconstruct. */
  hasSharedScreen: boolean('has_shared_screen').notNull().default(false),
  biggestCall: integer('biggest_call').notNull().default(0),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Tasks somebody has finished.
 *
 * The pair is the primary key, so awarding a task twice is impossible rather
 * than merely unlikely - the same reason friendships are keyed the way they
 * are. Every award is an insert that either succeeds once or conflicts, which
 * makes the whole grant path safe to run from anywhere, including twice at
 * once.
 */
export const userTasks = pgTable(
  'user_tasks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Matches an id in services/tasks.ts. Text, so the catalogue can grow. */
    taskId: text('task_id').notNull(),
    completedAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.taskId] }),
    index('user_tasks_user_idx').on(table.userId),
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
    /**
     * Null for a direct message.
     *
     * A DM is a text channel that belongs to no guild, rather than a parallel
     * kind of thing with its own table. That one decision is what lets
     * messages, editing, deletion, history paging and typing indicators work
     * for DMs without a line of new code - they all key on channelId and never
     * ask what the channel is attached to. What it costs is a branch anywhere
     * permissions are resolved, since a DM has no ranks to resolve through.
     */
    guildId: text('guild_id').references(() => guilds.id, { onDelete: 'cascade' }),
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

/**
 * The channel two people talk in, one per pair.
 *
 * Same sorted-pair primary key as friendships, for the same reason: both people
 * opening the conversation at the same moment must not create two channels for
 * it, and a unique key is the only way to be sure of that under concurrency.
 *
 * A separate table rather than columns on `channels` because these two fields
 * are meaningless for the other 99% of channels, and because the pair
 * constraint has to live somewhere it can be enforced.
 */
export const dmChannels = pgTable(
  'dm_channels',
  {
    userA: text('user_a')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userB: text('user_b')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userA, table.userB] }),
    uniqueIndex('dm_channels_channel_idx').on(table.channelId),
    index('dm_channels_a_idx').on(table.userA),
    index('dm_channels_b_idx').on(table.userB),
  ],
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
 * The notifications inbox: one row per DM that arrived and per message that
 * mentioned someone.
 *
 * A row per event rather than a per-channel unread counter, because the panel
 * shows the individual things and "mark this one read" needs a target. The
 * message it points at is kept by foreign key: if that message is deleted the
 * notification goes with it, which is what stops the inbox pointing at things
 * that are no longer there.
 *
 * `preview`, `authorId` and `guildId` are copied in rather than joined so the
 * panel renders from this table alone - a mention in a channel the reader has
 * since lost access to still shows who and where, the same way a report keeps
 * its quoted copy.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    /** Who this is for. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'dm' | 'mention'. Text so a third kind needs no migration. */
    kind: text('kind').notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** Null for a DM. */
    guildId: text('guild_id').references(() => guilds.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Short plain-text snippet, `<@id>` already resolved to a name. */
    preview: text('preview').notNull().default(''),
    createdAt: createdAt(),
    /** Null until opened or dismissed. */
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    // The panel reads "mine, unread first, newest first"; the badge counts
    // "mine where read_at is null". Both are this index.
    index('notifications_user_idx').on(table.userId, table.readAt, table.createdAt),
    // Opening a conversation marks every entry for that channel read.
    index('notifications_user_channel_idx').on(table.userId, table.channelId),
    // One notification per person per message: a message edited to add and
    // remove a mention must not pile up rows, and re-delivery on a retry is a
    // no-op rather than a duplicate.
    uniqueIndex('notifications_user_message_idx').on(table.userId, table.messageId, table.kind),
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
/**
 * Premium: a subscription, and the keys it comes with.
 *
 * Two things rather than one, because they answer different questions. The
 * subscription says whether somebody is paying right now; the ledger says where
 * every key they have ever had came from and went. Keeping them apart means
 * cancelling a subscription does not have to decide what happens to a balance.
 */
export const subscriptions = pgTable('subscriptions', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /**
   * Mirrors the payment provider rather than deciding anything itself. The
   * provider is the authority on whether money arrived; this is a local copy so
   * every request does not have to ask them.
   */
  status: text('status').notNull().default('none'),
  /**
   * Which provider, and their id for this subscription. Nullable because a
   * subscription can exist before payments are wired up - a comp, a test, or
   * the founder's own.
   */
  provider: text('provider'),
  providerId: text('provider_id'),
  /** When the paid-for period ends. Also when the next keys are due. */
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  /** The period whose keys have already been granted, so a retry cannot double up. */
  lastGrantedPeriodEnd: timestamp('last_granted_period_end', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every key in and every key out.
 *
 * A ledger rather than a balance column, because "how many keys do I have" is a
 * question you can answer either way but "where did my keys go" is a question
 * you can only answer from a ledger - and it is the one people actually ask,
 * usually when they think something has gone wrong. The balance is the sum.
 */
export const keyLedger = pgTable(
  'key_ledger',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Positive for keys gained, negative for keys spent. Never zero. */
    amount: integer('amount').notNull(),
    /** 'subscription' | 'purchase' | 'spend' | 'grant' | 'refund'. */
    reason: text('reason').notNull(),
    /**
     * What this entry is about - a cosmetic id, a provider payment id, the
     * period a grant was for. Also the idempotency key: one entry per reference
     * per person, so a webhook delivered twice pays out once.
     */
    reference: text('reference'),
    createdAt: createdAt(),
  },
  (table) => [
    index('key_ledger_user_idx').on(table.userId),
    uniqueIndex('key_ledger_reference_idx').on(table.userId, table.reason, table.reference),
  ],
);

/** What somebody owns, and what they are currently wearing. */
export const ownedCosmetics = pgTable(
  'owned_cosmetics',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** An id from the catalogue in services/cosmetics.ts, which is code. */
    cosmeticId: text('cosmetic_id').notNull(),
    /** Worn, as opposed to merely owned. At most one per slot - enforced in code. */
    equipped: boolean('equipped').notNull().default(false),
    acquiredAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.cosmeticId] }),
    index('owned_cosmetics_user_idx').on(table.userId),
  ],
);

/**
 * What platform staff did, and to whom.
 *
 * Power that reaches across every server needs a record, and it needs one that
 * is not the same log that rotates away in a week. This is small - who, what, to
 * whom, when - and it is written before the action rather than after, so an
 * action that fails halfway still leaves a trace of having been attempted.
 */
export const staffActions = pgTable(
  'staff_actions',
  {
    id: id(),
    actorId: text('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'black_card' | 'moderate' - kept as text so a new kind needs no migration. */
    action: text('action').notNull(),
    /** Who it was done to, where that makes sense. */
    subjectId: text('subject_id'),
    /** Anything worth being able to read back later. */
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (table) => [index('staff_actions_actor_idx').on(table.actorId)],
);

/**
 * Files sent with messages.
 *
 * The bytes are on disk, not in this table - see lib/storage.ts. Avatars are
 * `bytea` because they are tens of kilobytes and having them inside the backup
 * is a feature; a hundred-megabyte video is the opposite, and would make every
 * `pg_dump` carry it forever.
 *
 * `sha256` is where the file is, not merely a checksum: storage is content
 * addressed, so the same file sent twice is stored once and the second upload
 * costs nothing. It also means a row can never point at a path that was
 * computed differently from how it was written.
 *
 * `messageId` is nullable because an upload happens before the message exists -
 * you pick a file, it uploads while you finish typing, and the message that
 * carries it is created on send. A row that never gets a message is an
 * abandoned upload, and is what the sweeper looks for.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    /** Null until the message carrying it is sent. */
    messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    uploaderId: text('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** As the uploader's filesystem had it, for the download name. */
    name: text('name').notNull(),
    /** What the bytes actually are, sniffed - never what the client declared. */
    mimeType: text('mime_type').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    /** Images only, so the client can reserve the space before it loads. */
    width: integer('width'),
    height: integer('height'),
    createdAt: createdAt(),
  },
  (table) => [
    index('attachments_message_idx').on(table.messageId),
    // The sweeper's query: rows still waiting for a message, oldest first.
    index('attachments_orphan_idx').on(table.messageId, table.createdAt),
    // Whether any row still needs a file kept, asked once per delete.
    index('attachments_sha_idx').on(table.sha256),
  ],
);

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  message: one(messages, { fields: [attachments.messageId], references: [messages.id] }),
  uploader: one(users, { fields: [attachments.uploaderId], references: [users.id] }),
}));

/**
 * Custom emoji, per server.
 *
 * The bytes live on disk beside the attachments, addressed by the same content
 * hash - a picture is a picture, and having two ways to store one would mean
 * two things to back up and two ways to get the path wrong.
 *
 * `name` is unique per guild because that is what `:name:` has to resolve
 * against. Not unique globally: two servers calling their own picture `:yes:`
 * is normal, and each resolves inside the server it was typed in.
 */
export const guildEmoji = pgTable(
  'guild_emoji',
  {
    id: id(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** Lowercase letters, digits and underscores. What goes between the colons. */
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull(),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    creatorId: text('creator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('guild_emoji_name_idx').on(table.guildId, table.name),
    index('guild_emoji_guild_idx').on(table.guildId),
    // Asked before deleting a file: another emoji, or an attachment, may share
    // those bytes.
    index('guild_emoji_sha_idx').on(table.sha256),
  ],
);

/**
 * Something a person wants staff to look at.
 *
 * Moderation before this was entirely per-server: kick, ban and mute inside a
 * guild you have a rank in. That leaves nowhere at all to take behaviour by
 * someone who owns the server they are doing it in, and no way for anyone to
 * raise anything without knowing an operator personally.
 *
 * Two things here are load-bearing:
 *
 * `quoted` and `quotedAuthor` are a snapshot taken when the report is filed,
 * not a join. A reported message is very often deleted moments later - by the
 * author, or by the server owner who was the problem - and a queue of reports
 * pointing at nothing is a queue nobody can act on. The copy is what staff read.
 *
 * `messageId` is ON DELETE SET NULL for the same reason: the link is a
 * convenience, the snapshot is the evidence.
 */
export const reports = pgTable(
  'reports',
  {
    id: id(),
    reporterId: text('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who is being reported. Always present - a report is about a person. */
    subjectId: text('subject_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The message that prompted it, where there was one. */
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    /** Where it happened, so staff can find it. Null for a DM. */
    guildId: text('guild_id').references(() => guilds.id, { onDelete: 'set null' }),
    channelId: text('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    /** The message as it read when it was reported. */
    quoted: text('quoted'),
    /** What the reporter said about it. */
    reason: text('reason').notNull(),
    /** 'open' | 'actioned' | 'dismissed'. Text so a new outcome needs no migration. */
    status: text('status').notNull().default('open'),
    handledById: text('handled_by_id').references(() => users.id, { onDelete: 'set null' }),
    handledAt: timestamp('handled_at', { withTimezone: true }),
    /** What staff did about it, in their own words. */
    outcome: text('outcome'),
    createdAt: createdAt(),
  },
  (table) => [
    // The queue is read as "open, oldest first", which is exactly this index.
    index('reports_status_idx').on(table.status, table.createdAt),
    index('reports_subject_idx').on(table.subjectId),
    // One report per person per message. Reporting the same thing ten times
    // should not make it ten times as loud, and a queue is easier to work
    // through when each row is a distinct thing rather than a tally.
    uniqueIndex('reports_one_per_message_idx').on(table.reporterId, table.messageId),
  ],
);

/**
 * Three separate links to `users` from one row, so each needs naming.
 *
 * Drizzle cannot tell which foreign key a relation means when a table points at
 * the same table more than once, and this one points at users three times - who
 * complained, who they complained about, and who dealt with it.
 */
export const reportsRelations = relations(reports, ({ one }) => ({
  reporter: one(users, { fields: [reports.reporterId], references: [users.id] }),
  subject: one(users, { fields: [reports.subjectId], references: [users.id] }),
  handledBy: one(users, { fields: [reports.handledById], references: [users.id] }),
  message: one(messages, { fields: [reports.messageId], references: [messages.id] }),
  guild: one(guilds, { fields: [reports.guildId], references: [guilds.id] }),
  channel: one(channels, { fields: [reports.channelId], references: [channels.id] }),
}));

export const guildEmojiRelations = relations(guildEmoji, ({ one }) => ({
  guild: one(guilds, { fields: [guildEmoji.guildId], references: [guilds.id] }),
  creator: one(users, { fields: [guildEmoji.creatorId], references: [users.id] }),
}));

export type GuildEmojiRow = typeof guildEmoji.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type VoiceStateRow = typeof voiceStates.$inferSelect;
export type RankRow = typeof ranks.$inferSelect;
export type BanRow = typeof bans.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type KeyLedgerRow = typeof keyLedger.$inferSelect;
export type OwnedCosmeticRow = typeof ownedCosmetics.$inferSelect;
export type StaffActionRow = typeof staffActions.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
