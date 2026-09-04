import { randomInt } from 'node:crypto';

/**
 * Snowflake IDs: 64-bit, k-sortable, generated without a round trip to the
 * database.
 *
 *   | 42 bits ms since epoch | 10 bits worker | 12 bits sequence |
 *
 * Sortable by creation time, which means "messages after id X" is an index
 * range scan rather than a join against a timestamp, and IDs leak creation time
 * but nothing else (unlike auto-increment, which leaks total row counts).
 *
 * Stored as decimal strings: JSON has no 64-bit integer type, and silently
 * rounding IDs through a double is a class of bug worth designing out.
 */

/** 2024-01-01T00:00:00Z. Buys ~139 years of 42-bit millisecond range. */
const EPOCH = 1_704_067_200_000n;

const WORKER_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

// A random worker id is fine for a handful of processes; collisions only matter
// if two workers emit within the same millisecond *and* land on the same
// sequence number. Assign this from an env var if you scale past ~30 instances.
const workerId = BigInt(randomInt(0, 1 << Number(WORKER_BITS)));

let lastTimestamp = -1n;
let sequence = 0n;

export function generateId(): string {
  let now = BigInt(Date.now());

  // Clock went backwards (NTP correction). Rather than risk emitting a
  // duplicate, wait it out - this is microseconds in practice.
  if (now < lastTimestamp) {
    while (now < lastTimestamp) now = BigInt(Date.now());
  }

  if (now === lastTimestamp) {
    sequence = (sequence + 1n) & MAX_SEQUENCE;
    if (sequence === 0n) {
      // 4096 IDs exhausted inside one millisecond; spin to the next.
      while (now <= lastTimestamp) now = BigInt(Date.now());
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = now;
  const id = ((now - EPOCH) << (WORKER_BITS + SEQUENCE_BITS)) | (workerId << SEQUENCE_BITS) | sequence;
  return id.toString();
}

/** Creation time embedded in a snowflake, or null if it is not one. */
export function timestampFromId(id: string): Date | null {
  try {
    const value = BigInt(id);
    if (value <= 0n) return null;
    return new Date(Number((value >> (WORKER_BITS + SEQUENCE_BITS)) + EPOCH));
  } catch {
    return null;
  }
}

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) && timestampFromId(value) !== null;
}
