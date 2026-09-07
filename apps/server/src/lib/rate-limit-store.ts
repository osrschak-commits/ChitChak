import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * The Redis connection the rate limiter counts in.
 *
 * Counters lived in process memory, which is correct for exactly one API
 * process and quietly wrong for two: each instance would keep its own tally, so
 * the limit anyone actually experiences is the configured one multiplied by the
 * number of instances. The failure is invisible - nothing errors, the limits are
 * simply not the limits.
 *
 * That matters more now than it did. The endpoints being protected are the ones
 * worth attacking: sign-in, password reset, and friend requests, which reach a
 * person who did not ask to hear from you.
 *
 * Its own connection rather than sharing presence's or the registry's. ioredis
 * multiplexes commands over one socket, but the registry's subscriber is in
 * subscribe mode - a connection that has subscribed accepts almost nothing else -
 * and a rate limiter that stops counting because something else changed how it
 * used its client is a bad way to find that out.
 */
export const rateLimitRedis = new Redis(config.REDIS_URL, {
  // The plugin is on the request path. A command that queues forever behind a
  // reconnect would hold requests open; failing fast lets the plugin fall back.
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  enableOfflineQueue: false,
});

export async function connectRateLimitRedis(): Promise<void> {
  await rateLimitRedis.connect();
}

export async function disconnectRateLimitRedis(): Promise<void> {
  await rateLimitRedis.quit().catch(() => {
    // Shutting down; a refused quit is not worth failing the exit over.
  });
}
