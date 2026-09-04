import type { PresenceStatus } from '@chitchak/protocol';
import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * Who is online, counted across every API instance.
 *
 * Presence cannot be a per-process boolean: with two instances, a user with a
 * desktop client on one and a browser tab on the other would be marked offline
 * the moment either disconnected. So each connection increments a shared
 * counter and the user is online while that counter is above zero.
 *
 * The counters carry a TTL. If a process is killed without running its cleanup,
 * its contribution expires rather than pinning someone online forever; live
 * sessions refresh the TTL on every heartbeat.
 */

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

const CONNECTIONS_KEY = (userId: string) => `chitchak:presence:conn:${userId}`;
const STATUS_KEY = (userId: string) => `chitchak:presence:status:${userId}`;
/** Comfortably longer than the heartbeat interval, short enough to self-heal quickly. */
const TTL_SECONDS = 90;

export async function startPresence(): Promise<void> {
  await redis.connect();
}

export async function stopPresence(): Promise<void> {
  await redis.quit().catch(() => {});
}

/** @returns true if this was the user's first connection (they just came online). */
export async function addConnection(userId: string, status: PresenceStatus): Promise<boolean> {
  const results = await redis
    .multi()
    .incr(CONNECTIONS_KEY(userId))
    .expire(CONNECTIONS_KEY(userId), TTL_SECONDS)
    .set(STATUS_KEY(userId), status, 'EX', TTL_SECONDS)
    .exec();

  const count = Number(results?.[0]?.[1] ?? 0);
  return count === 1;
}

/** @returns true if this was the user's last connection (they just went offline). */
export async function removeConnection(userId: string): Promise<boolean> {
  const remaining = await redis.decr(CONNECTIONS_KEY(userId));
  if (remaining <= 0) {
    await redis.del(CONNECTIONS_KEY(userId), STATUS_KEY(userId));
    return true;
  }
  await redis.expire(CONNECTIONS_KEY(userId), TTL_SECONDS);
  return false;
}

/** Called on each heartbeat so a live session never lets its keys lapse. */
export async function touchConnection(userId: string): Promise<void> {
  await redis
    .multi()
    .expire(CONNECTIONS_KEY(userId), TTL_SECONDS)
    .expire(STATUS_KEY(userId), TTL_SECONDS)
    .exec();
}

export async function setStatus(userId: string, status: PresenceStatus): Promise<void> {
  await redis.set(STATUS_KEY(userId), status, 'EX', TTL_SECONDS);
}

export async function getStatuses(
  userIds: string[],
): Promise<Array<{ userId: string; status: PresenceStatus }>> {
  if (userIds.length === 0) return [];
  const values = await redis.mget(userIds.map(STATUS_KEY));
  const out: Array<{ userId: string; status: PresenceStatus }> = [];
  values.forEach((value, index) => {
    const userId = userIds[index];
    // Absent key means no live connection anywhere; offline is the default and
    // is not worth sending explicitly.
    if (!userId || !value) return;
    out.push({ userId, status: value as PresenceStatus });
  });
  return out;
}
