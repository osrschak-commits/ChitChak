import { AccessToken, RoomServiceClient, TrackSource, type VideoGrant } from 'livekit-server-sdk';
import { config } from '../config.js';

/**
 * Everything that talks to the SFU.
 *
 * The API server never touches media. Its only jobs are (a) deciding who is
 * allowed into which room and minting a narrowly-scoped token that says so, and
 * (b) issuing moderation commands. Audio flows client <-> SFU directly.
 */

const roomService = new RoomServiceClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

/**
 * One SFU room per voice channel. Prefixed so that room names can never collide
 * with anything else we might put on the same SFU later (screen shares, calls).
 */
export function roomNameForChannel(channelId: string): string {
  return `voice:${channelId}`;
}

export function channelIdFromRoomName(room: string): string | null {
  return room.startsWith('voice:') ? room.slice('voice:'.length) : null;
}

/**
 * Mints a join token.
 *
 * The grant is the whole security boundary for media: it names exactly one
 * room, and the SFU will not let this token near any other. `auto_create` is
 * off in the SFU config, so a token for a room the API server never created is
 * useless - a client cannot invent rooms by guessing names.
 *
 * TTL is short. It only needs to survive the few seconds between the gateway
 * handing it over and the client completing its WebRTC handshake; the SFU keeps
 * the session alive after that regardless of token expiry.
 */
export async function createVoiceToken(params: {
  channelId: string;
  userId: string;
  displayName: string;
  canSpeak?: boolean;
  canUseCamera?: boolean;
  canScreenShare?: boolean;
}): Promise<string> {
  const canSpeak = params.canSpeak ?? true;
  const canUseCamera = params.canUseCamera ?? true;
  const canScreenShare = params.canScreenShare ?? true;

  // The allowlist is built from the member's actual permissions, so SPEAK,
  // VIDEO and SCREEN_SHARE are enforced by the SFU. Hiding a button in the UI
  // is a courtesy; this is the boundary that a modified client cannot cross.
  const sources: TrackSource[] = [];
  if (canSpeak) sources.push(TrackSource.MICROPHONE);
  if (canUseCamera) sources.push(TrackSource.CAMERA);
  if (canScreenShare) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);

  const grant: VideoGrant = {
    room: roomNameForChannel(params.channelId),
    roomJoin: true,
    // Someone with no publish rights at all still joins to listen.
    canPublish: sources.length > 0,
    canSubscribe: true,
    // Used for low-latency signalling that should not round-trip through our
    // gateway, e.g. live speaking indicators within a call.
    canPublishData: true,
    canPublishSources: sources,
  };

  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    // Identity is the join key the SFU deduplicates on: connecting twice with
    // the same identity disconnects the older session, which is exactly the
    // behaviour we want when someone opens a second client.
    identity: params.userId,
    name: params.displayName,
    ttl: '2m',
  });
  token.addGrant(grant);

  return token.toJwt();
}

/** Idempotent: creating a room that already exists returns the existing one. */
export async function ensureRoom(channelId: string): Promise<void> {
  await roomService.createRoom({
    name: roomNameForChannel(channelId),
    // Reap the room shortly after the last person leaves, but not instantly -
    // otherwise a brief reconnect destroys and recreates it.
    emptyTimeout: 30,
    departureTimeout: 20,
    maxParticipants: 0,
  });
}

/** Who the SFU actually believes is connected, as opposed to what our DB says. */
export async function listParticipants(channelId: string): Promise<string[]> {
  const participants = await roomService.listParticipants(roomNameForChannel(channelId));
  return participants.map((p) => p.identity);
}

/** Force-disconnect. Used for kicks and for reconciling stale voice state. */
export async function removeParticipant(channelId: string, userId: string): Promise<void> {
  try {
    await roomService.removeParticipant(roomNameForChannel(channelId), userId);
  } catch (error) {
    // Already gone is the common case (they disconnected first) and is a
    // success as far as the caller is concerned.
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Server-side mute, enforced by the SFU rather than by client cooperation.
 * This is the one a moderator applies; a self-mute is handled client-side by
 * simply not publishing, which keeps push-to-talk responsive.
 */
export async function setServerMute(channelId: string, userId: string, muted: boolean): Promise<void> {
  const room = roomNameForChannel(channelId);
  try {
    const participant = await roomService.getParticipant(room, userId);
    for (const track of participant.tracks) {
      if (track.type === 0 /* AUDIO */) {
        await roomService.mutePublishedTrack(room, userId, track.sid, muted);
      }
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Server deafen, enforced by the SFU.
 *
 * Muting someone is easy - stop their track. Deafening is the harder half:
 * you cannot ask a client not to listen and expect it to comply. So the SFU
 * revokes their subscribe permission and stops forwarding anyone's audio to
 * them at all. Publishing goes with it, because being able to talk while
 * hearing nothing is not a state worth having.
 *
 * The rest of the participant's permissions are read back and preserved, so
 * this does not quietly widen or narrow what they may publish.
 */
export async function setServerDeafen(
  channelId: string,
  userId: string,
  deafened: boolean,
): Promise<void> {
  const room = roomNameForChannel(channelId);
  try {
    const participant = await roomService.getParticipant(room, userId);
    const permission = participant.permission;

    await roomService.updateParticipant(room, userId, undefined, {
      ...permission,
      canSubscribe: !deafened,
      canPublish: deafened ? false : (permission?.canPublish ?? true),
      canPublishData: permission?.canPublishData ?? true,
      canPublishSources: permission?.canPublishSources ?? [],
      hidden: permission?.hidden ?? false,
      recorder: permission?.recorder ?? false,
      agent: permission?.agent ?? false,
      canUpdateMetadata: permission?.canUpdateMetadata ?? false,
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export async function deleteRoom(channelId: string): Promise<void> {
  try {
    await roomService.deleteRoom(roomNameForChannel(channelId));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|does not exist|404/i.test(message);
}

export const livekitUrl = config.LIVEKIT_URL;
