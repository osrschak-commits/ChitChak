import { EventEmitter } from 'node:events';
import type { ServerMessage } from '@chitchak/protocol';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import type { Session } from './session.js';

/**
 * Routes gateway events to the sockets that should see them.
 *
 * A single process could do this with a Map and nothing else. Redis pub/sub is
 * here because the moment there are two API instances behind a load balancer,
 * two members of the same guild will be connected to different processes, and
 * an in-memory map silently delivers events to half the people who should get
 * them. Publishing every fan-out through Redis means the routing logic is
 * identical at one instance and at ten.
 *
 * Delivery is at-most-once and events are not replayed on reconnect: the client
 * refetches a snapshot when it reconnects rather than trying to replay a gap.
 */

interface Envelope {
  /** Instance that published it, so we can skip echoing to ourselves twice. */
  origin: string;
  /** Deliver to every session whose user is a member of this guild. */
  guildId?: string;
  /** Deliver to these users specifically, wherever they are connected. */
  userIds?: string[];
  /** Never deliver to this user (e.g. the actor, who already applied it locally). */
  exceptUserId?: string;
  message: ServerMessage;
}

const CHANNEL = 'chitchak:gateway';

export class GatewayRegistry extends EventEmitter {
  /** userId -> that user's live sockets. A user may have several (desktop + web). */
  private readonly sessionsByUser = new Map<string, Set<Session>>();
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private ready = false;

  constructor() {
    super();
    this.publisher = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    this.subscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  }

  async start(): Promise<void> {
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (_channel, raw) => {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(raw) as Envelope;
      } catch {
        return;
      }
      // Skip the echo of our own publish - `publish` already delivered it.
      if (envelope.origin === this.instanceId) return;
      this.deliverLocally(envelope);
    });
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    await Promise.allSettled([this.subscriber.quit(), this.publisher.quit()]);
  }

  // --- Session lifecycle ---------------------------------------------------

  add(session: Session): void {
    let set = this.sessionsByUser.get(session.userId);
    if (!set) {
      set = new Set();
      this.sessionsByUser.set(session.userId, set);
    }
    set.add(session);
  }

  remove(session: Session): void {
    const set = this.sessionsByUser.get(session.userId);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) this.sessionsByUser.delete(session.userId);
  }

  /** True once the user's last socket has gone - the point at which they go offline. */
  isUserOffline(userId: string): boolean {
    return !this.sessionsByUser.has(userId);
  }

  localSessionsFor(userId: string): Session[] {
    return [...(this.sessionsByUser.get(userId) ?? [])];
  }

  get localSessionCount(): number {
    let total = 0;
    for (const set of this.sessionsByUser.values()) total += set.size;
    return total;
  }

  // --- Fan-out -------------------------------------------------------------

  /** Everyone in the guild, optionally excluding the user who caused the event. */
  publishToGuild(guildId: string, message: ServerMessage, exceptUserId?: string): void {
    this.publish({ origin: this.instanceId, guildId, exceptUserId, message });
  }

  /** Specific users, wherever they happen to be connected. */
  publishToUsers(userIds: string[], message: ServerMessage): void {
    if (userIds.length === 0) return;
    this.publish({ origin: this.instanceId, userIds, message });
  }

  /**
   * Deliver only to this process's own sockets for a user.
   *
   * Used for things that are meaningless elsewhere - a voice token is bound to
   * the specific socket that asked for it, so broadcasting it would hand a
   * second client credentials it never requested.
   */
  sendToLocalUser(userId: string, message: ServerMessage): void {
    for (const session of this.localSessionsFor(userId)) session.send(message);
  }

  private publish(envelope: Envelope): void {
    // Apply locally first so a Redis hiccup degrades to single-instance
    // behaviour rather than to no behaviour at all.
    this.deliverLocally(envelope);
    if (!this.ready) return;
    this.publisher.publish(CHANNEL, JSON.stringify(envelope)).catch(() => {
      // Fan-out is best-effort; clients resync on reconnect.
    });
  }

  /** Deliver to this process's sockets only. Never publishes onward. */
  private deliverLocally(envelope: Envelope): void {
    if (envelope.userIds) {
      for (const userId of envelope.userIds) {
        if (userId === envelope.exceptUserId) continue;
        for (const session of this.localSessionsFor(userId)) session.send(envelope.message);
      }
      return;
    }

    if (envelope.guildId) {
      for (const [userId, sessions] of this.sessionsByUser) {
        if (userId === envelope.exceptUserId) continue;
        for (const session of sessions) {
          if (session.isInGuild(envelope.guildId)) session.send(envelope.message);
        }
      }
    }
  }

  /** Disconnect every socket, used on graceful shutdown. */
  closeAll(code: number, reason: string): void {
    for (const sessions of this.sessionsByUser.values()) {
      for (const session of sessions) session.close(code, reason);
    }
  }
}

export const registry = new GatewayRegistry();
