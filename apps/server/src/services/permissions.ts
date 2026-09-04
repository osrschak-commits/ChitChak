import {
  ALL_PERMISSIONS,
  Permission,
  applyOverwrites,
  has,
} from '@chitchak/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { channelOverwrites, channels, guildMembers, guilds, memberRanks, ranks } from '../db/schema.js';
import { errors } from '../lib/errors.js';

/**
 * Permission resolution.
 *
 * Every privileged action funnels through here. The rules, in order:
 *
 *   1. The owner has everything, always, and cannot be acted upon.
 *   2. Otherwise permissions are the union of every rank held, including the
 *      guild's implicit default rank.
 *   3. ADMINISTRATOR grants everything and ignores channel overwrites.
 *   4. For a channel, that base is adjusted by the overwrites of the ranks held.
 *
 * Deliberately not cached. A stale permission cache is how someone keeps access
 * after their rank is taken away, and these are indexed lookups on small tables.
 */

export interface MemberContext {
  guildId: string;
  userId: string;
  isOwner: boolean;
  /** Union of every rank's permissions, before channel overwrites. */
  permissions: number;
  /** Position of the highest rank held. Owner is treated as above everyone. */
  position: number;
  rankIds: string[];
}

/** @throws if the user is not a member of the guild. */
export async function memberContext(guildId: string, userId: string): Promise<MemberContext> {
  const [guild, membership] = await Promise.all([
    db.query.guilds.findFirst({ where: eq(guilds.id, guildId) }),
    db.query.guildMembers.findFirst({
      where: and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)),
    }),
  ]);

  if (!guild) throw errors.notFound('No such server');
  if (!membership) throw errors.forbidden('You are not a member of that server');

  if (guild.ownerId === userId) {
    return {
      guildId,
      userId,
      isOwner: true,
      permissions: ALL_PERMISSIONS,
      // Above any real rank, so hierarchy checks always favour the owner.
      position: Number.MAX_SAFE_INTEGER,
      rankIds: [],
    };
  }

  const held = await db
    .select({ rank: ranks })
    .from(memberRanks)
    .innerJoin(ranks, eq(ranks.id, memberRanks.rankId))
    .where(and(eq(memberRanks.guildId, guildId), eq(memberRanks.userId, userId)));

  // The default rank is held implicitly - it is never written to member_ranks,
  // so that changing which rank is default does not need a backfill.
  const defaultRank = await db.query.ranks.findFirst({
    where: and(eq(ranks.guildId, guildId), eq(ranks.isDefault, true)),
  });

  const all = [...held.map((h) => h.rank), ...(defaultRank ? [defaultRank] : [])];
  const permissions = all.reduce((acc, rank) => acc | rank.permissions, 0);
  const position = all.reduce((acc, rank) => Math.max(acc, rank.position), 0);

  return {
    guildId,
    userId,
    isOwner: false,
    permissions,
    position,
    rankIds: held.map((h) => h.rank.id),
  };
}

/** Effective permissions in one channel, with its overwrites applied. */
export async function channelPermissions(
  context: MemberContext,
  channelId: string,
): Promise<number> {
  if (context.isOwner || has(context.permissions, Permission.ADMINISTRATOR)) {
    return ALL_PERMISSIONS;
  }

  const defaultRank = await db.query.ranks.findFirst({
    where: and(eq(ranks.guildId, context.guildId), eq(ranks.isDefault, true)),
  });

  const relevant = [...context.rankIds, ...(defaultRank ? [defaultRank.id] : [])];
  if (relevant.length === 0) return context.permissions;

  const overwrites = await db
    .select()
    .from(channelOverwrites)
    .where(
      and(eq(channelOverwrites.channelId, channelId), inArray(channelOverwrites.rankId, relevant)),
    );

  return applyOverwrites(context.permissions, overwrites);
}

/** @throws unless the member holds `permission` guild-wide. */
export async function requirePermission(
  guildId: string,
  userId: string,
  permission: number,
  message?: string,
): Promise<MemberContext> {
  const context = await memberContext(guildId, userId);
  if (!has(context.permissions, permission)) {
    throw errors.forbidden(message ?? 'You do not have permission to do that');
  }
  return context;
}

/** @throws unless the member holds `permission` in that specific channel. */
export async function requireChannelPermission(
  channelId: string,
  userId: string,
  permission: number,
  message?: string,
): Promise<{ context: MemberContext; permissions: number; guildId: string }> {
  const channel = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
  if (!channel) throw errors.notFound('No such channel');

  const context = await memberContext(channel.guildId, userId);
  const permissions = await channelPermissions(context, channelId);

  // A channel you cannot view is reported as missing rather than forbidden:
  // "you may not read this" still confirms it exists.
  if (!has(permissions, Permission.VIEW_CHANNEL)) throw errors.notFound('No such channel');
  if (!has(permissions, permission)) {
    throw errors.forbidden(message ?? 'You do not have permission to do that');
  }

  return { context, permissions, guildId: channel.guildId };
}

/**
 * Hierarchy check for actions aimed at another member.
 *
 * You must outrank the target strictly. Without this, everyone with
 * KICK_MEMBERS could kick everyone else who has it, including the person who
 * gave it to them.
 */
export async function requireOutranks(
  actor: MemberContext,
  targetUserId: string,
): Promise<void> {
  if (actor.userId === targetUserId) {
    throw errors.invalid('You cannot do that to yourself');
  }

  const guild = await db.query.guilds.findFirst({ where: eq(guilds.id, actor.guildId) });
  if (guild?.ownerId === targetUserId) {
    throw errors.forbidden('The server owner cannot be moderated');
  }
  if (actor.isOwner) return;

  const target = await memberContext(actor.guildId, targetUserId);
  if (target.position >= actor.position) {
    throw errors.forbidden('You cannot moderate someone at or above your own rank');
  }
}

/**
 * Guards rank edits: you may not create, edit, delete or assign a rank at or
 * above your own highest, or you could grant yourself more than you have.
 */
export async function requireRankBelow(actor: MemberContext, rankPosition: number): Promise<void> {
  if (actor.isOwner) return;
  if (rankPosition >= actor.position) {
    throw errors.forbidden('You cannot manage a rank at or above your own');
  }
}

/**
 * Channel ids in a guild that this member may see.
 *
 * Every channel's overwrites are fetched in one query and resolved in memory
 * rather than one query per channel: this runs for every guild on every gateway
 * connect, and a per-channel round trip there is a reconnect storm waiting to
 * happen.
 */
export async function visibleChannelIds(context: MemberContext): Promise<Set<string>> {
  const guildChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.guildId, context.guildId));

  if (context.isOwner || has(context.permissions, Permission.ADMINISTRATOR)) {
    return new Set(guildChannels.map((c) => c.id));
  }

  const defaultRank = await db.query.ranks.findFirst({
    where: and(eq(ranks.guildId, context.guildId), eq(ranks.isDefault, true)),
  });
  const relevant = [...context.rankIds, ...(defaultRank ? [defaultRank.id] : [])];

  const channelIds = guildChannels.map((c) => c.id);
  const rows =
    channelIds.length > 0 && relevant.length > 0
      ? await db
          .select()
          .from(channelOverwrites)
          .where(
            and(
              inArray(channelOverwrites.channelId, channelIds),
              inArray(channelOverwrites.rankId, relevant),
            ),
          )
      : [];

  const byChannel = new Map<string, Array<{ allow: number; deny: number }>>();
  for (const row of rows) {
    const list = byChannel.get(row.channelId) ?? [];
    list.push({ allow: row.allow, deny: row.deny });
    byChannel.set(row.channelId, list);
  }

  const visible = new Set<string>();
  for (const channel of guildChannels) {
    const resolved = applyOverwrites(context.permissions, byChannel.get(channel.id) ?? []);
    if (has(resolved, Permission.VIEW_CHANNEL)) visible.add(channel.id);
  }
  return visible;
}
