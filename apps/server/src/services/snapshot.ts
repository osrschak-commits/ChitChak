import type { ChannelOverwrite, GuildMember, Rank, ReadyPayload } from '@chitchak/protocol';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  channelOverwrites,
  channels,
  guildMembers,
  guilds,
  memberRanks,
  ranks,
  users,
  voiceStates,
} from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { memberContext, visibleChannelIds } from './permissions.js';
import {
  compareChannels,
  compareRanks,
  toChannel,
  toGuild,
  toOverwrite,
  toPublicUserFields,
  toRank,
  toSelfUser,
  toVoiceState,
} from './serialize.js';

/**
 * The snapshot sent immediately after `identify`.
 *
 * The client is a pure function of this plus the event stream that follows, so
 * reconnecting is just "fetch a new snapshot and throw the old state away" -
 * there is no incremental catch-up protocol to get subtly wrong.
 *
 * Channels the user cannot view are omitted entirely rather than sent with a
 * flag. A client that never receives a private channel cannot leak its name,
 * its topic, or who is sitting in it.
 */
export async function buildReadySnapshot(userId: string): Promise<ReadyPayload> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw errors.unauthorized('Account no longer exists');

  const memberships = await db
    .select({ guildId: guildMembers.guildId })
    .from(guildMembers)
    .where(eq(guildMembers.userId, userId));
  const guildIds = memberships.map((m) => m.guildId);

  const self = toSelfUser(user);

  if (guildIds.length === 0) {
    return {
      user: self,
      guilds: [],
      channels: [],
      members: [],
      ranks: [],
      overwrites: [],
      voiceStates: [],
      presences: [],
    };
  }

  const [guildRows, channelRows, memberRows, rankRows, memberRankRows, voiceRows] =
    await Promise.all([
      db
        .select()
        .from(guilds)
        .where(inArray(guilds.id, guildIds))
        .orderBy(asc(guilds.createdAt), asc(guilds.id)),
      db.select().from(channels).where(inArray(channels.guildId, guildIds)),
      db
        .select({
          guildId: guildMembers.guildId,
          nickname: guildMembers.nickname,
          joinedAt: guildMembers.joinedAt,
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          avatarVersion: users.avatarVersion,
          bio: users.bio,
          accentColor: users.accentColor,
        })
        .from(guildMembers)
        .innerJoin(users, eq(users.id, guildMembers.userId))
        .where(inArray(guildMembers.guildId, guildIds)),
      db.select().from(ranks).where(inArray(ranks.guildId, guildIds)),
      db.select().from(memberRanks).where(inArray(memberRanks.guildId, guildIds)),
      db.select().from(voiceStates).where(inArray(voiceStates.guildId, guildIds)),
    ]);

  // Visibility is per guild, because permissions are.
  const visible = new Set<string>();
  for (const guildId of guildIds) {
    const context = await memberContext(guildId, userId);
    for (const channelId of await visibleChannelIds(context)) visible.add(channelId);
  }

  const visibleChannels = channelRows.filter((c) => visible.has(c.id));

  const rankIdsByMember = new Map<string, string[]>();
  for (const row of memberRankRows) {
    const key = `${row.guildId}:${row.userId}`;
    rankIdsByMember.set(key, [...(rankIdsByMember.get(key) ?? []), row.rankId]);
  }

  const memberList: GuildMember[] = memberRows.map((m) => ({
    guildId: m.guildId,
    userId: m.id,
    nickname: m.nickname,
    joinedAt: m.joinedAt.toISOString(),
    rankIds: rankIdsByMember.get(`${m.guildId}:${m.id}`) ?? [],
    user: toPublicUserFields(m),
  }));

  const rankList: Rank[] = rankRows.map(toRank).sort(compareRanks);

  // Overwrites are only meaningful for channels the client can see; sending
  // them for hidden channels would leak that those channels exist.
  const overwriteRows = visibleChannels.length
    ? await db
        .select()
        .from(channelOverwrites)
        .where(
          inArray(
            channelOverwrites.channelId,
            visibleChannels.map((c) => c.id),
          ),
        )
    : [];
  const overwriteList: ChannelOverwrite[] = overwriteRows.map(toOverwrite);

  return {
    user: self,
    guilds: guildRows.map(toGuild),
    channels: visibleChannels.map(toChannel).sort(compareChannels),
    members: memberList,
    ranks: rankList,
    overwrites: overwriteList,
    // Voice state for a hidden channel would reveal who is in it.
    voiceStates: voiceRows.filter((v) => visible.has(v.channelId)).map(toVoiceState),
    // Presence is derived from live sockets and filled in by the gateway, which
    // is the only component that knows who is actually connected.
    presences: [],
  };
}

/** Guild ids a user belongs to - the routing key for their event fan-out. */
export async function guildIdsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ guildId: guildMembers.guildId })
    .from(guildMembers)
    .where(eq(guildMembers.userId, userId));
  return rows.map((r) => r.guildId);
}

/** The member payload for one person, used by events that report a change. */
export async function buildMember(guildId: string, userId: string): Promise<GuildMember | null> {
  const [row] = await db
    .select({
      guildId: guildMembers.guildId,
      nickname: guildMembers.nickname,
      joinedAt: guildMembers.joinedAt,
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarVersion: users.avatarVersion,
      bio: users.bio,
      accentColor: users.accentColor,
    })
    .from(guildMembers)
    .innerJoin(users, eq(users.id, guildMembers.userId))
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
    .limit(1);

  if (!row) return null;

  const heldRanks = await db
    .select({ rankId: memberRanks.rankId })
    .from(memberRanks)
    .where(and(eq(memberRanks.guildId, guildId), eq(memberRanks.userId, userId)));

  return {
    guildId,
    userId,
    nickname: row.nickname,
    joinedAt: row.joinedAt.toISOString(),
    rankIds: heldRanks.map((r) => r.rankId),
    user: toPublicUserFields(row),
  };
}
