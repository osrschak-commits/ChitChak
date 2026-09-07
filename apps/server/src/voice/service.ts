import type { VideoQuality, VoiceCredentials, VoiceState, VoiceUpdatePayload } from '@chitchak/protocol';
import { Permission, has } from '@chitchak/protocol';
import { and, count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { channels, guildMembers, users, voiceStates } from '../db/schema.js';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
import { requireChannelPermission, requireGuildChannel } from '../services/permissions.js';
import { standingOf } from '../services/subscriptions.js';
import { noteScreenShare } from './xp-ticker.js';
import { toVoiceState } from '../services/serialize.js';
import { createVoiceToken, ensureRoom, livekitUrl, removeParticipant } from './livekit.js';

/**
 * Voice channel membership.
 *
 * The rule this module exists to enforce: a client never picks its own room. It
 * asks to join a channel, the server checks membership and capacity, and only
 * then mints a token scoped to that one room. A compromised client can lie
 * about anything it likes over the gateway and still cannot get audio or video
 * from a guild it is not in.
 */

export async function joinVoiceChannel(
  userId: string,
  channelId: string,
): Promise<{ credentials: VoiceCredentials; state: VoiceState }> {
  // Voice lives in guilds only: a DM has no voice channel, and requireGuildChannel
  // reports one as missing rather than confirming it exists.
  const channel = await requireGuildChannel(channelId);
  if (channel.kind !== 'voice') throw errors.invalid('That channel is not a voice channel');

  // CONNECT is checked against the channel, not the guild, so a rank can be
  // denied one room without losing voice everywhere.
  const { context, permissions } = await requireChannelPermission(
    channelId,
    userId,
    Permission.CONNECT,
    'You do not have permission to join that channel',
  );

  const [membership, user] = await Promise.all([
    db.query.guildMembers.findFirst({
      where: and(eq(guildMembers.guildId, channel.guildId), eq(guildMembers.userId, userId)),
    }),
    db.query.users.findFirst({ where: eq(users.id, userId) }),
  ]);
  if (!membership) throw errors.forbidden('You are not a member of that server');
  if (!user) throw errors.unauthorized();
  void context;

  if (channel.userLimit > 0) {
    const [occupancy] = await db
      .select({ value: count() })
      .from(voiceStates)
      .where(eq(voiceStates.channelId, channelId));
    const occupants = occupancy?.value ?? 0;
    // Someone already in this channel who rejoins (reconnect, device switch)
    // must not be counted against the limit and locked out of their own seat.
    const alreadyHere = await db.query.voiceStates.findFirst({
      where: and(eq(voiceStates.userId, userId), eq(voiceStates.channelId, channelId)),
    });
    if (!alreadyHere && occupants >= channel.userLimit) throw errors.channelFull();
  }

  const previous = await db.query.voiceStates.findFirst({ where: eq(voiceStates.userId, userId) });

  // A user is in at most one voice channel at a time, so joining is a move.
  // Tear down the old membership first: the SFU deduplicates by identity, but
  // the old room's occupant list would otherwise keep showing them.
  if (previous && previous.channelId !== channelId) {
    await removeParticipant(previous.channelId, userId).catch(() => {});
    registry.publishToGuild(previous.guildId, {
      op: 'voice:state',
      d: { ...toVoiceState(previous), channelId: null },
    });
  }

  await ensureRoom(channelId);

  const [row] = await db
    .insert(voiceStates)
    .values({
      userId,
      guildId: channel.guildId,
      channelId,
      selfMuted: previous?.selfMuted ?? false,
      selfDeafened: previous?.selfDeafened ?? false,
      serverMuted: false,
      // Camera and screen share always start off. Moving between channels
      // should never silently keep a camera live in a room you just entered.
      selfVideo: false,
      selfScreenShare: false,
    })
    .onConflictDoUpdate({
      target: voiceStates.userId,
      set: {
        guildId: channel.guildId,
        channelId,
        joinedAt: new Date(),
        serverMuted: false,
        selfVideo: false,
        selfScreenShare: false,
      },
    })
    .returning();

  if (!row) throw errors.invalid('Could not record voice state');

  // The grant mirrors the member's permissions, so SPEAK, VIDEO and
  // SCREEN_SHARE are enforced by the SFU itself. A modified client that hides
  // our disabled buttons still cannot publish what it was not granted.
  const token = await createVoiceToken({
    channelId,
    userId,
    displayName: membership.nickname ?? user.displayName,
    canSpeak: has(permissions, Permission.SPEAK),
    canUseCamera: has(permissions, Permission.VIDEO),
    canScreenShare: has(permissions, Permission.SCREEN_SHARE),
  });

  const state = toVoiceState(row);
  // Tell the guild where this person now is. The joiner learns it from the
  // credentials response, so they are excluded to avoid a duplicate apply.
  registry.publishToGuild(channel.guildId, { op: 'voice:state', d: state }, userId);

  return {
    credentials: { channelId, url: livekitUrl, token, video: await videoQualityFor(userId) },
    state,
  };
}

/**
 * Put somebody back in the channel they never actually left.
 *
 * A gateway restart closes every socket, and closing a socket clears its voice
 * state - which is right when someone quits the app and wrong when the server
 * is the thing going away. The SFU is a separate connection and survives it, so
 * after a deploy everyone is still talking to each other in a room the database
 * says is empty. Nothing recovers on its own: `voice:update` is an UPDATE, so
 * once the row is gone even toggling your microphone cannot bring it back.
 *
 * So on reconnect a client that is still in a call says so, and this writes the
 * row again and tells the guild. Deliberately not `joinVoiceChannel`: that
 * mints a fresh SFU token, and connecting with it evicts the session that is
 * currently carrying the conversation - tearing down a working call in order to
 * fix a database row.
 *
 * Permission is rechecked rather than assumed. Time passed while the server was
 * down, and someone whose access was removed in the meantime must not be able
 * to resume their way back in.
 */
export async function resumeVoiceChannel(
  userId: string,
  channelId: string,
): Promise<VoiceState | null> {
  const channel = await requireGuildChannel(channelId);
  if (channel.kind !== 'voice') return null;

  await requireChannelPermission(
    channelId,
    userId,
    Permission.CONNECT,
    'You do not have permission to join that channel',
  );

  const membership = await db.query.guildMembers.findFirst({
    where: and(eq(guildMembers.guildId, channel.guildId), eq(guildMembers.userId, userId)),
  });
  if (!membership) return null;

  const existing = await db.query.voiceStates.findFirst({
    where: eq(voiceStates.userId, userId),
  });
  // Already recorded in the right place - nothing to repair, and nothing worth
  // telling the guild about.
  if (existing?.channelId === channelId) return toVoiceState(existing);
  // In a different channel now. Whatever this client remembers is out of date;
  // the record wins.
  if (existing) return null;

  const [row] = await db
    .insert(voiceStates)
    .values({
      userId,
      guildId: channel.guildId,
      channelId,
      selfMuted: false,
      selfDeafened: false,
      serverMuted: false,
      // The client sends its own mute and camera state along right afterwards.
      selfVideo: false,
      selfScreenShare: false,
    })
    .onConflictDoNothing()
    .returning();

  if (!row) return null;

  const state = toVoiceState(row);
  registry.publishToGuild(channel.guildId, { op: 'voice:state', d: state }, userId);
  return state;
}

/**
 * What a subscription is worth in pixels.
 *
 * The free tier is not a punishment - 720p30 is a perfectly good screen share,
 * and most people watching are looking at a window a third of their screen.
 * What a subscription buys is the difference that shows when somebody is
 * presenting something detailed, or playing something fast.
 */
const FREE_VIDEO: VideoQuality = {
  width: 1280,
  height: 720,
  frameRate: 30,
  maxBitrate: 1_800_000,
};

const SUBSCRIBER_VIDEO: VideoQuality = {
  width: 1920,
  height: 1080,
  frameRate: 60,
  maxBitrate: 5_000_000,
};

async function videoQualityFor(userId: string): Promise<VideoQuality> {
  try {
    return (await standingOf(userId)).active ? SUBSCRIBER_VIDEO : FREE_VIDEO;
  } catch (error) {
    // A subscription lookup that fails must not stop somebody joining a call.
    // The free tier is the safe answer: it works for everybody.
    console.error('[voice] could not read a subscription for video quality', { userId, error });
    return FREE_VIDEO;
  }
}

export async function leaveVoiceChannel(userId: string): Promise<VoiceState | null> {
  const [row] = await db.delete(voiceStates).where(eq(voiceStates.userId, userId)).returning();
  if (!row) return null;

  // Best effort: the client normally disconnects from the SFU itself, and this
  // only matters when it vanished without doing so.
  await removeParticipant(row.channelId, userId).catch(() => {});

  const state: VoiceState = { ...toVoiceState(row), channelId: null };
  registry.publishToGuild(row.guildId, { op: 'voice:state', d: state });
  return state;
}

export async function updateSelfVoiceState(
  userId: string,
  patch: VoiceUpdatePayload,
): Promise<VoiceState | null> {
  // Deafening implies muting. Enforced here rather than trusted from the client
  // so every observer agrees on what the icons mean.
  const selfMuted = patch.selfDeafened ? true : patch.selfMuted;

  // One-off, and only worth recording the first time it turns on.
  if (patch.selfScreenShare) void noteScreenShare(userId);

  const [row] = await db
    .update(voiceStates)
    .set({
      selfMuted,
      selfDeafened: patch.selfDeafened,
      selfVideo: patch.selfVideo,
      selfScreenShare: patch.selfScreenShare,
    })
    .where(eq(voiceStates.userId, userId))
    .returning();
  if (!row) return null;

  const state = toVoiceState(row);
  registry.publishToGuild(row.guildId, { op: 'voice:state', d: state }, userId);
  return state;
}

/**
 * Moves someone to another voice channel, as a moderator action.
 *
 * The target still needs CONNECT on the destination: being moved is not a way
 * to get into a channel you could not join yourself.
 */
export async function moveToChannel(userId: string, channelId: string): Promise<VoiceState> {
  const { credentials, state } = await joinVoiceChannel(userId, channelId);
  // Sent to that user only, but across instances - the person being moved may
  // well be connected to a different API process than the moderator.
  registry.publishToUsers([userId], { op: 'voice:credentials', d: credentials });
  registry.publishToUsers([userId], { op: 'voice:state', d: state });
  return state;
}

/**
 * Called when a user's last socket closes.
 *
 * Without this, a client that crashes leaves a ghost sitting in the channel
 * list forever - visible to everyone, in no actual call.
 */
export async function clearVoiceStateOnDisconnect(userId: string): Promise<void> {
  await leaveVoiceChannel(userId);
}
