import type {
  Channel,
  ChannelOverwrite,
  Guild,
  GuildMember,
  Message,
  PresenceStatus,
  PublicUser,
  Rank,
  SelfUser,
  Snowflake,
  VoiceState,
} from './entities.js';

/**
 * The realtime gateway protocol.
 *
 * One WebSocket per client carries everything that is not a plain request/
 * response: presence, voice state, text messages. Media never touches it - that
 * goes directly to the SFU over WebRTC.
 *
 * Both directions are a discriminated union on `op`, so `switch (msg.op)`
 * narrows exhaustively and adding a case without handling it is a type error.
 */

export const GATEWAY_VERSION = 1;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface VoiceUpdatePayload {
  selfMuted: boolean;
  selfDeafened: boolean;
  selfVideo: boolean;
  selfScreenShare: boolean;
}

export type ClientMessage =
  /** Must be the first frame sent. The socket is closed if it does not arrive in time. */
  | { op: 'identify'; d: { token: string } }
  | { op: 'heartbeat'; d: { seq: number } }
  | { op: 'voice:join'; d: { channelId: Snowflake } }
  | { op: 'voice:leave'; d: Record<string, never> }
  | { op: 'voice:update'; d: VoiceUpdatePayload }
  | { op: 'presence:update'; d: { status: PresenceStatus } }
  | { op: 'message:create'; d: { channelId: Snowflake; content: string; nonce?: string } }
  | { op: 'typing:start'; d: { channelId: Snowflake } };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

/** Snapshot of everything the client needs to render, sent once after identify. */
export interface ReadyPayload {
  user: SelfUser;
  guilds: Guild[];
  /** Only channels this user may view; a hidden channel is absent, not flagged. */
  channels: Channel[];
  members: GuildMember[];
  ranks: Rank[];
  overwrites: ChannelOverwrite[];
  voiceStates: VoiceState[];
  presences: Array<{ userId: Snowflake; status: PresenceStatus }>;
}

/** Credentials for the SFU. Short-lived and scoped to exactly one room. */
export interface VoiceCredentials {
  channelId: Snowflake;
  /** WebSocket URL of the SFU, e.g. ws://localhost:7880 */
  url: string;
  /** JWT the client passes to the SFU. Grants publish+subscribe on this room only. */
  token: string;
}

export type ServerMessage =
  | { op: 'hello'; d: { heartbeatIntervalMs: number; gatewayVersion: number } }
  | { op: 'ready'; d: ReadyPayload }
  | { op: 'heartbeat:ack'; d: { seq: number } }
  | { op: 'error'; d: { code: GatewayErrorCode; message: string } }
  | { op: 'voice:credentials'; d: VoiceCredentials }
  | { op: 'voice:state'; d: VoiceState }
  | { op: 'presence:update'; d: { userId: Snowflake; status: PresenceStatus } }
  | { op: 'message:create'; d: Message & { nonce?: string } }
  | { op: 'typing:start'; d: { channelId: Snowflake; userId: Snowflake; expiresAt: string } }
  | { op: 'guild:member_add'; d: GuildMember }
  | { op: 'guild:member_remove'; d: { guildId: Snowflake; userId: Snowflake } }
  /** Ranks or nickname changed for a member. */
  | { op: 'guild:member_update'; d: GuildMember }
  | { op: 'guild:update'; d: Guild }
  | { op: 'guild:delete'; d: { guildId: Snowflake } }
  | { op: 'channel:create'; d: Channel }
  | { op: 'channel:update'; d: Channel }
  | { op: 'channel:delete'; d: { guildId: Snowflake; channelId: Snowflake } }
  | { op: 'rank:create'; d: Rank }
  | { op: 'rank:update'; d: Rank }
  | { op: 'rank:delete'; d: { guildId: Snowflake; rankId: Snowflake } }
  /** The full overwrite set for one channel, replacing whatever the client held. */
  | { op: 'channel:overwrites'; d: { channelId: Snowflake; overwrites: ChannelOverwrite[] } }
  | { op: 'message:update'; d: Message }
  | { op: 'message:delete'; d: { channelId: Snowflake; messageId: Snowflake } }
  /** A profile changed. Sent to every guild the user shares with the recipient. */
  | { op: 'user:update'; d: PublicUser };

export type GatewayErrorCode =
  | 'invalid_token'
  | 'already_identified'
  | 'not_identified'
  | 'rate_limited'
  | 'unknown_channel'
  | 'forbidden'
  | 'channel_full'
  | 'invalid_payload'
  | 'internal';

/** Close codes above 4000 are application-defined; the client uses these to decide whether to retry. */
export const GatewayCloseCode = {
  /** Retry with backoff. */
  SessionTimeout: 4000,
  /** Do not retry with the same token - re-authenticate first. */
  AuthenticationFailed: 4001,
  /** Client sent garbage. Bug on our side; do not hot-loop. */
  ProtocolError: 4002,
  /** Same account connected elsewhere and took over the session. */
  SessionReplaced: 4003,
} as const;

export type GatewayCloseCode = (typeof GatewayCloseCode)[keyof typeof GatewayCloseCode];

export const HEARTBEAT_INTERVAL_MS = 20_000;
/** How long the server waits past a missed heartbeat before assuming the client is gone. */
export const HEARTBEAT_GRACE_MS = 10_000;
/** How long a client has to send `identify` after connecting. */
export const IDENTIFY_TIMEOUT_MS = 10_000;
