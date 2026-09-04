import {
  GatewayCloseCode,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  IDENTIFY_TIMEOUT_MS,
  GATEWAY_VERSION,
  type ClientMessage,
  type PresenceStatus,
  type ServerMessage,
} from '@chitchak/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { db } from '../db/client.js';
import { channels } from '../db/schema.js';
import { isAppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { buildReadySnapshot, guildIdsForUser } from '../services/snapshot.js';
import { createMessage } from '../services/messages.js';
import {
  clearVoiceStateOnDisconnect,
  joinVoiceChannel,
  leaveVoiceChannel,
  updateSelfVoiceState,
} from '../voice/service.js';
import * as presence from './presence.js';
import { registry } from './registry.js';

/**
 * One connected client.
 *
 * The socket starts unauthenticated and is closed if `identify` does not arrive
 * promptly, so an unauthenticated peer can never hold a connection open or send
 * anything that touches the database.
 */

const MAX_FRAME_BYTES = 16 * 1024;
/** Ops allowed per window, per socket. Generous for a human, ruinous for a script. */
const RATE_LIMIT_OPS = 60;
const RATE_LIMIT_WINDOW_MS = 10_000;

export class Session {
  readonly id: string;
  userId = '';
  private readonly socket: WebSocket;
  /** Re-bound after identify so every later line carries the user id. */
  private log: FastifyBaseLogger;

  private identified = false;
  private closed = false;
  private guildIds = new Set<string>();
  private status: PresenceStatus = 'online';

  private identifyTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private lastHeartbeat = Date.now();

  private opCount = 0;
  private windowStartedAt = Date.now();

  constructor(socket: WebSocket, log: FastifyBaseLogger) {
    this.id = Math.random().toString(36).slice(2, 10);
    this.socket = socket;
    this.log = log.child({ session: this.id });

    this.socket.on('message', (raw: Buffer) => {
      void this.handleRaw(raw);
    });
    this.socket.on('close', () => {
      void this.teardown();
    });
    this.socket.on('error', (error: Error) => {
      this.log.debug({ err: error }, 'gateway socket error');
      void this.teardown();
    });

    this.send({
      op: 'hello',
      d: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, gatewayVersion: GATEWAY_VERSION },
    });

    this.identifyTimer = setTimeout(() => {
      if (!this.identified) {
        this.close(GatewayCloseCode.AuthenticationFailed, 'identify timeout');
      }
    }, IDENTIFY_TIMEOUT_MS);
  }

  // --- Outbound ------------------------------------------------------------

  send(message: ServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.log.debug({ err: error }, 'failed to send gateway frame');
    }
  }

  private sendError(code: Extract<ServerMessage, { op: 'error' }>['d']['code'], message: string): void {
    this.send({ op: 'error', d: { code, message } });
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    try {
      this.socket.close(code, reason);
    } catch {
      // Socket already destroyed; teardown still needs to run.
    }
    void this.teardown();
  }

  isInGuild(guildId: string): boolean {
    return this.guildIds.has(guildId);
  }

  // --- Inbound -------------------------------------------------------------

  private async handleRaw(raw: Buffer): Promise<void> {
    if (raw.length > MAX_FRAME_BYTES) {
      this.close(GatewayCloseCode.ProtocolError, 'frame too large');
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString('utf8')) as ClientMessage;
    } catch {
      this.close(GatewayCloseCode.ProtocolError, 'malformed json');
      return;
    }

    if (typeof message?.op !== 'string') {
      this.close(GatewayCloseCode.ProtocolError, 'missing op');
      return;
    }

    if (!this.withinRateLimit()) {
      this.sendError('rate_limited', 'Too many gateway messages');
      return;
    }

    try {
      await this.dispatch(message);
    } catch (error) {
      if (isAppError(error)) {
        this.sendError(error.code, error.message);
        return;
      }
      this.log.error({ err: error, op: message.op }, 'gateway handler threw');
      this.sendError('internal', 'Something went wrong handling that');
    }
  }

  private async dispatch(message: ClientMessage): Promise<void> {
    if (message.op === 'identify') {
      await this.handleIdentify(message.d?.token);
      return;
    }

    if (!this.identified) {
      this.sendError('not_identified', 'Send identify first');
      this.close(GatewayCloseCode.AuthenticationFailed, 'not identified');
      return;
    }

    switch (message.op) {
      case 'heartbeat': {
        this.lastHeartbeat = Date.now();
        this.send({ op: 'heartbeat:ack', d: { seq: message.d?.seq ?? 0 } });
        await presence.touchConnection(this.userId);
        return;
      }

      case 'voice:join': {
        const channelId = message.d?.channelId;
        if (typeof channelId !== 'string') {
          this.sendError('invalid_payload', 'channelId is required');
          return;
        }
        const { credentials, state } = await joinVoiceChannel(this.userId, channelId);
        // Credentials go only to the socket that asked. A second client of the
        // same user has no business receiving a token it did not request.
        this.send({ op: 'voice:credentials', d: credentials });
        this.send({ op: 'voice:state', d: state });
        return;
      }

      case 'voice:leave': {
        const state = await leaveVoiceChannel(this.userId);
        if (state) this.send({ op: 'voice:state', d: state });
        return;
      }

      case 'voice:update': {
        const state = await updateSelfVoiceState(this.userId, {
          selfMuted: Boolean(message.d?.selfMuted),
          selfDeafened: Boolean(message.d?.selfDeafened),
          selfVideo: Boolean(message.d?.selfVideo),
          selfScreenShare: Boolean(message.d?.selfScreenShare),
        });
        if (state) this.send({ op: 'voice:state', d: state });
        return;
      }

      case 'presence:update': {
        const status = message.d?.status;
        if (!isPresenceStatus(status)) {
          this.sendError('invalid_payload', 'Unknown presence status');
          return;
        }
        this.status = status;
        await presence.setStatus(this.userId, status);
        this.broadcastPresence(status);
        return;
      }

      case 'message:create': {
        const created = await createMessage({
          authorId: this.userId,
          channelId: message.d?.channelId,
          content: message.d?.content,
        });
        registry.publishToGuild(created.guildId, {
          op: 'message:create',
          d: { ...created.message, nonce: undefined },
        }, this.userId);
        // Echo to the author with their nonce so the optimistic bubble the
        // client already rendered can be reconciled instead of duplicated.
        this.send({
          op: 'message:create',
          d: { ...created.message, nonce: message.d?.nonce },
        });
        return;
      }

      case 'typing:start': {
        const channelId = message.d?.channelId;
        if (typeof channelId !== 'string') return;
        const guildId = await this.guildIdForChannel(channelId);
        if (!guildId) return;
        registry.publishToGuild(
          guildId,
          {
            op: 'typing:start',
            d: {
              channelId,
              userId: this.userId,
              expiresAt: new Date(Date.now() + 8_000).toISOString(),
            },
          },
          this.userId,
        );
        return;
      }

      default: {
        // Unknown ops are ignored rather than fatal: an older server should
        // tolerate a newer client sending something it does not understand.
        const unknown = message as { op: string };
        this.log.debug({ op: unknown.op }, 'unknown gateway op');
      }
    }
  }

  private async handleIdentify(token: unknown): Promise<void> {
    if (this.identified) {
      this.sendError('already_identified', 'Already identified');
      return;
    }
    if (typeof token !== 'string' || token.length === 0) {
      this.close(GatewayCloseCode.AuthenticationFailed, 'missing token');
      return;
    }

    const claims = await verifyAccessToken(token);
    if (!claims) {
      this.sendError('invalid_token', 'Access token is invalid or expired');
      this.close(GatewayCloseCode.AuthenticationFailed, 'invalid token');
      return;
    }

    this.userId = claims.userId;
    this.identified = true;
    clearTimeout(this.identifyTimer);
    this.identifyTimer = undefined;
    this.log = this.log.child({ userId: this.userId });

    const snapshot = await buildReadySnapshot(this.userId);
    this.guildIds = new Set(snapshot.guilds.map((g) => g.id));

    registry.add(this);

    const cameOnline = await presence.addConnection(this.userId, this.status);

    // Fill in presence for everyone the client can see, so their member list is
    // correct on first paint rather than only after people move.
    const visibleUserIds = [...new Set(snapshot.members.map((m) => m.userId))];
    snapshot.presences = await presence.getStatuses(visibleUserIds);

    this.send({ op: 'ready', d: snapshot });

    if (cameOnline) this.broadcastPresence(this.status);

    this.startHeartbeatWatchdog();
  }

  // --- Housekeeping --------------------------------------------------------

  private broadcastPresence(status: PresenceStatus): void {
    for (const guildId of this.guildIds) {
      registry.publishToGuild(guildId, {
        op: 'presence:update',
        d: { userId: this.userId, status },
      }, this.userId);
    }
  }

  private startHeartbeatWatchdog(): void {
    this.lastHeartbeat = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const silentFor = Date.now() - this.lastHeartbeat;
      if (silentFor > HEARTBEAT_INTERVAL_MS + HEARTBEAT_GRACE_MS) {
        // A TCP connection can stay open long after the peer is unreachable.
        // The heartbeat is what actually detects a dead client, and dropping it
        // here is what stops them lingering in a voice channel as a ghost.
        this.log.debug({ silentFor }, 'heartbeat timeout, closing session');
        this.close(GatewayCloseCode.SessionTimeout, 'heartbeat timeout');
      }
    }, HEARTBEAT_INTERVAL_MS / 2);
  }

  private withinRateLimit(): boolean {
    const now = Date.now();
    if (now - this.windowStartedAt > RATE_LIMIT_WINDOW_MS) {
      this.windowStartedAt = now;
      this.opCount = 0;
    }
    this.opCount += 1;
    return this.opCount <= RATE_LIMIT_OPS;
  }

  private async guildIdForChannel(channelId: string): Promise<string | null> {
    const channel = await db.query.channels.findFirst({ where: eq(channels.id, channelId) });
    if (!channel || !this.guildIds.has(channel.guildId)) return null;
    return channel.guildId;
  }

  private async teardown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    clearTimeout(this.identifyTimer);
    clearInterval(this.heartbeatTimer);

    if (!this.identified) return;

    registry.remove(this);

    try {
      const wentOffline = await presence.removeConnection(this.userId);
      if (wentOffline) {
        // Only drop them out of voice when their *last* client goes: switching
        // from desktop to phone should not kick them out of the call.
        await clearVoiceStateOnDisconnect(this.userId);
        this.broadcastPresenceOffline();
      }
    } catch (error) {
      this.log.error({ err: error }, 'session teardown failed');
    }
  }

  private broadcastPresenceOffline(): void {
    for (const guildId of this.guildIds) {
      registry.publishToGuild(guildId, {
        op: 'presence:update',
        d: { userId: this.userId, status: 'offline' },
      });
    }
  }
}

function isPresenceStatus(value: unknown): value is PresenceStatus {
  return value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline';
}
