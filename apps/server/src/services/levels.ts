import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userStats } from '../db/schema.js';

/**
 * Experience and levels.
 *
 * Two rules hold the whole design up, and both live here rather than being
 * repeated at each call site:
 *
 *   - A message earns XP at most once a minute. Posting twice in ten seconds
 *     earns what posting once does, which makes flooding worthless without ever
 *     refusing a message or telling anyone off.
 *   - Tasks count XP-earning actions, not actions. "1,000 messages" therefore
 *     means a thousand that each cleared that cooldown - a thousand real
 *     minutes of talking. One rule defends the whole catalogue instead of each
 *     task needing its own defence.
 */

/** Levels start at 1, and nobody is ever below it. */
export const STARTING_LEVEL = 1;

/**
 * XP to get from `level` to the next one: 5n² + 50n + 100.
 *
 * Quadratic, so each level costs more than the last - the shape people already
 * have an instinct for from every game that has ever done this.
 */
export function xpForNextLevel(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/**
 * The level a given total buys, and the progress through it.
 *
 * Loops rather than solving the cumulative polynomial: levels are small
 * numbers, the loop is exact, and inverting a sum of squares in floating point
 * is a good way to have somebody sit at 99% forever because of a rounding error.
 */
export function levelFromXp(totalXp: number): {
  level: number;
  intoLevel: number;
  needed: number;
} {
  let level = STARTING_LEVEL;
  let remaining = Math.max(0, totalXp);

  while (remaining >= xpForNextLevel(level)) {
    remaining -= xpForNextLevel(level);
    level += 1;
    // Nothing should reach this, and an infinite loop from a corrupt total
    // would take the process with it.
    if (level > 1000) break;
  }

  return { level, intoLevel: remaining, needed: xpForNextLevel(level) };
}

/** How long a message must wait before another one earns anything. */
export const MESSAGE_XP_COOLDOWN_MS = 60_000;
/** Varied, so it is not a counter people can watch tick up predictably. */
export const MESSAGE_XP_MIN = 15;
export const MESSAGE_XP_MAX = 25;
/** Per minute in a call with someone else in it. */
export const VOICE_XP_PER_MINUTE = 10;

export function randomMessageXp(): number {
  return MESSAGE_XP_MIN + Math.floor(Math.random() * (MESSAGE_XP_MAX - MESSAGE_XP_MIN + 1));
}

export type Stats = typeof userStats.$inferSelect;

/**
 * The row, created empty on first sight.
 *
 * Everyone who has never earned anything has no row, so absence means zero and
 * nothing has to be backfilled for existing accounts.
 */
export async function ensureStats(userId: string): Promise<Stats> {
  const existing = await db.query.userStats.findFirst({ where: eq(userStats.userId, userId) });
  if (existing) return existing;

  const [created] = await db
    .insert(userStats)
    .values({ userId })
    // Two requests can arrive together for someone's first ever message.
    .onConflictDoNothing()
    .returning();

  return (
    created ??
    (await db.query.userStats.findFirst({ where: eq(userStats.userId, userId) }))!
  );
}

export interface Award {
  xp: number;
  level: number;
  levelledUp: boolean;
}

/**
 * Add XP and recompute the level.
 *
 * The increment is done in SQL rather than read-modify-write: two awards
 * arriving together - a message and a voice tick, say - would otherwise both
 * read the same total and one would overwrite the other, silently losing XP in
 * a way nobody would ever notice or be able to reconstruct.
 */
export async function awardXp(userId: string, amount: number): Promise<Award> {
  if (amount <= 0) {
    const stats = await ensureStats(userId);
    return { xp: stats.xp, level: stats.level, levelledUp: false };
  }

  const before = await ensureStats(userId);

  const [updated] = await db
    .update(userStats)
    .set({ xp: sql`${userStats.xp} + ${amount}`, updatedAt: new Date() })
    .where(eq(userStats.userId, userId))
    .returning();

  if (!updated) return { xp: before.xp, level: before.level, levelledUp: false };

  const { level } = levelFromXp(updated.xp);
  const levelledUp = level > updated.level;

  if (level !== updated.level) {
    await db.update(userStats).set({ level }).where(eq(userStats.userId, userId));
  }

  return { xp: updated.xp, level, levelledUp };
}

/**
 * Whether this message earns anything, and note that it did.
 *
 * The check and the write are one statement with the cooldown in its WHERE
 * clause, so two messages sent in the same instant cannot both pass: the second
 * update matches no row and returns nothing. Reading the timestamp and then
 * writing it would let both through.
 */
export async function claimMessageXp(userId: string): Promise<boolean> {
  await ensureStats(userId);
  const cutoff = new Date(Date.now() - MESSAGE_XP_COOLDOWN_MS);

  const claimed = await db
    .update(userStats)
    .set({ lastMessageXpAt: new Date() })
    // Built from typed column helpers rather than a raw `sql` fragment. In a raw
    // fragment the Date reaches the driver as a Date, which it cannot bind - and
    // the resulting rejection is thrown from deep inside the connection, far
    // from anything expecting it.
    .where(
      and(
        eq(userStats.userId, userId),
        or(isNull(userStats.lastMessageXpAt), lte(userStats.lastMessageXpAt, cutoff)),
      ),
    )
    .returning({ userId: userStats.userId });

  return claimed.length > 0;
}

/** Today, in UTC, as the `date` column stores it. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Record that somebody was around today, and keep the streak honest.
 *
 * UTC dates throughout: a streak that breaks because someone flew to Spain
 * would be a strange thing to have to explain.
 */
export async function touchStreak(userId: string): Promise<{ streak: number; isNewDay: boolean }> {
  const stats = await ensureStats(userId);
  const now = today();

  if (stats.lastActiveDate === now) {
    return { streak: stats.currentStreak, isNewDay: false };
  }

  // Yesterday continues it; anything longer ago starts again at one.
  const streak =
    stats.lastActiveDate && daysBetween(stats.lastActiveDate, now) === 1
      ? stats.currentStreak + 1
      : 1;

  await db
    .update(userStats)
    .set({ lastActiveDate: now, currentStreak: streak })
    .where(eq(userStats.userId, userId));

  return { streak, isNewDay: true };
}
