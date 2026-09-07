import { sql } from 'drizzle-orm';
import { awardXp, levelFromXp } from '../services/levels.js';
import { TASKS, claimTask, completedTaskIds } from '../services/tasks.js';
import { closeDatabase, db } from './client.js';
import { userStats, users } from './schema.js';

/**
 * Credits people for what they did before levels existed.
 *
 * Levels shipped on 2026-09-07 and started counting from zero, so everyone who
 * was already here looked like they had never done anything: servers made,
 * people invited, messages sent, all worth nothing. This walks the catalogue
 * against the real history and pays out what was already earned.
 *
 * Run it once per deployment that has users predating levels. New accounts need
 * nothing - they earn as they go.
 *
 *   node apps/server/dist/db/backfill-levels.js            # report only
 *   node apps/server/dist/db/backfill-levels.js --apply    # write it
 *   node apps/server/dist/db/backfill-levels.js --apply chakras   # one person
 *
 * What it will not do, and why:
 *
 *   - Voice tasks. Call time was never recorded before levels; `voice_seconds`
 *     and the rest begin at zero because there is genuinely nothing to read.
 *     Inventing hours nobody can verify would make every voice number in the
 *     app a guess, which is worse than starting them at zero.
 *   - Streaks longer than the messages show. The streak is rebuilt from the days
 *     somebody actually posted, and only counts if it runs up to today or
 *     yesterday - a streak that ended last week has ended.
 *
 * Idempotent. Task claims collide on their primary key, and the historical
 * message XP is itself claimed as `backfill.messages`, so a second run pays out
 * nothing. That id is not in the catalogue, so it renders nowhere; the table is
 * simply the right shape for "this person has had this, once, ever".
 */

const MESSAGES_CLAIM = 'backfill.messages';

/**
 * What a message was worth, for messages nobody was scoring at the time.
 *
 * Live awards roll 15-25 so the number is not a metronome. A backfill has no
 * reason to be random - two runs of the same history should agree - so it pays
 * the midpoint.
 */
const BACKFILL_MESSAGE_XP = 20;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.find((arg) => !arg.startsWith('--'));

/**
 * Minutes in which this person said something.
 *
 * Live, a message earns once a minute and no more, so the honest historical
 * equivalent is the number of distinct minutes they posted in - not the number
 * of messages, which is exactly the count the cooldown exists to ignore.
 */
async function earningMinutes(userId: string): Promise<number> {
  const [row] = await db.execute<{ minutes: string }>(sql`
    select count(distinct date_trunc('minute', created_at)) as minutes
    from messages where author_id = ${userId}
  `);
  return Number(row?.minutes ?? 0);
}

/** The days they posted, newest first, as YYYY-MM-DD. */
async function activeDays(userId: string): Promise<string[]> {
  const rows = await db.execute<{ day: string }>(sql`
    select distinct to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day
    from messages where author_id = ${userId} order by day desc
  `);
  return rows.map((row) => row.day);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The streak they are currently on, from the days they posted.
 *
 * Counts back from the most recent day, stopping at the first gap. A run that
 * ended before yesterday is not a current streak and returns 0 - the number
 * means "days in a row up to now", and quietly redefining it to "the best run
 * you ever had" would make it say something it does not say anywhere else.
 */
function currentStreak(days: string[], todayUtc: string): number {
  if (days.length === 0) return 0;
  const gapToNow = daysBetween(days[0]!, todayUtc);
  if (gapToNow > 1) return 0;

  let streak = 1;
  for (let i = 1; i < days.length; i += 1) {
    if (daysBetween(days[i]!, days[i - 1]!) !== 1) break;
    streak += 1;
  }
  return streak;
}

const todayUtc = new Date().toISOString().slice(0, 10);
const everyone = await db.select({ id: users.id, username: users.username }).from(users);
const chosen = only ? everyone.filter((user) => user.username === only) : everyone;

if (only && chosen.length === 0) {
  console.error(`No user called "${only}".`);
  await closeDatabase();
  process.exit(1);
}

console.log(
  apply
    ? `\nBackfilling ${chosen.length} account${chosen.length === 1 ? '' : 's'}.\n`
    : `\nDry run over ${chosen.length} account${chosen.length === 1 ? '' : 's'}. Add --apply to write.\n`,
);

for (const user of chosen) {
  const already = await completedTaskIds(user.id);
  const lines: string[] = [];
  let credited = 0;

  // --- Streak, rebuilt from when they actually posted -------------------------
  const days = await activeDays(user.id);
  const streak = currentStreak(days, todayUtc);
  if (apply && days.length > 0) {
    await db
      .insert(userStats)
      .values({ userId: user.id, lastActiveDate: days[0]!, currentStreak: streak })
      .onConflictDoUpdate({
        target: userStats.userId,
        set: { lastActiveDate: days[0]!, currentStreak: streak },
      });
  }
  if (days.length > 0) {
    lines.push(`  streak         ${streak} (last posted ${days[0]}, ${days.length} days in all)`);
  }

  // --- XP for messages sent before anyone was counting ------------------------
  if (!already.has(MESSAGES_CLAIM)) {
    const minutes = await earningMinutes(user.id);
    const messageXp = minutes * BACKFILL_MESSAGE_XP;
    if (messageXp > 0) {
      if (apply && (await claimTask(user.id, MESSAGES_CLAIM))) {
        await awardXp(user.id, messageXp);
      }
      credited += messageXp;
      lines.push(`  messages       +${messageXp} XP (${minutes} earning minutes)`);
    }
  }

  // --- Everything in the catalogue they had already done ----------------------
  // The streak write above lands first on purpose: the habit.streak tasks read
  // that column, and checking them against a zero we were about to replace
  // would deny a streak the messages plainly show.
  for (const task of TASKS) {
    if (already.has(task.id)) continue;

    const value = await task.check(user.id);
    if (value < task.goal) continue;

    if (apply && !(await claimTask(user.id, task.id))) continue;
    if (apply) await awardXp(user.id, task.xp);

    credited += task.xp;
    lines.push(`  ${task.id.padEnd(14)} +${String(task.xp).padStart(5)} XP  ${task.name}`);
  }

  if (lines.length === 0) continue;

  const [stats] = await db
    .select({ xp: userStats.xp })
    .from(userStats)
    .where(sql`${userStats.userId} = ${user.id}`);
  // On a dry run nothing has been written, so add what would be.
  const total = apply ? (stats?.xp ?? 0) : (stats?.xp ?? 0) + credited;
  const { level, intoLevel, needed } = levelFromXp(total);

  console.log(`${user.username}`);
  for (const line of lines) console.log(line);
  console.log(`  => ${total} XP, level ${level} (${intoLevel} of ${needed} into it)\n`);
}

if (!apply) console.log('Nothing was written.\n');

await closeDatabase();
