import type { PublicUser } from '@chitchak/protocol';
import { registry } from '../gateway/registry.js';
import {
  awardXp,
  claimMessageXp,
  ensureStats,
  levelFromXp,
  randomMessageXp,
  touchStreak,
} from './levels.js';
import { TASKS, claimTask, completedTaskIds, type Trigger } from './tasks.js';

/**
 * The one door XP and tasks go through.
 *
 * Everywhere that can earn something calls `progress()` with what just
 * happened, and this decides the rest. Nothing else awards XP, so there is one
 * place to look when a number is wrong, and one place that knows how to tell
 * the client.
 *
 * It never throws into its caller. Levelling is a decoration on top of the app:
 * a failure to award XP for a message must not fail sending the message, and
 * the alternative - a try/catch at every call site - is a rule somebody
 * eventually forgets.
 */

export interface ProgressResult {
  xp: number;
  level: number;
  levelledUp: boolean;
  completed: Array<{ id: string; name: string; xp: number }>;
}

export async function progress(
  userId: string,
  trigger: Trigger,
  directXp = 0,
): Promise<ProgressResult> {
  const empty: ProgressResult = { xp: 0, level: 1, levelledUp: false, completed: [] };

  try {
    let award = await awardXp(userId, directXp);
    const completed: ProgressResult['completed'] = [];

    // Only the tasks this event could possibly have moved. Checking all of them
    // on every message would be twenty-odd queries per line typed.
    const relevant = TASKS.filter((task) => task.trigger === trigger);
    if (relevant.length > 0) {
      const already = await completedTaskIds(userId);

      for (const task of relevant) {
        if (already.has(task.id)) continue;

        const value = await task.check(userId);
        if (value < task.goal) continue;

        // The insert is the claim, so two triggers racing cannot both pay out.
        if (!(await claimTask(userId, task.id))) continue;

        const afterTask = await awardXp(userId, task.xp);
        // Levelling up during a run of task grants still counts as levelling up.
        award = { ...afterTask, levelledUp: award.levelledUp || afterTask.levelledUp };
        completed.push({ id: task.id, name: task.name, xp: task.xp });
      }
    }

    if (completed.length > 0 || award.levelledUp) {
      announce(userId, award.level, award.levelledUp, completed);
    }

    return { ...award, completed };
  } catch (error) {
    // Swallowed, but never silently. The action that triggered this has already
    // succeeded and must not be undone by a scoring problem - but a scoring
    // system that fails without saying so is one whose numbers quietly stop
    // being true, and nobody finds out until somebody asks why their level
    // never moved.
    console.error('[progress] failed', { userId, trigger, error });
    return empty;
  }
}

function announce(
  userId: string,
  level: number,
  levelledUp: boolean,
  completed: ProgressResult['completed'],
): void {
  if (levelledUp) {
    registry.publishToUsers([userId], { op: 'level:up', d: { level } });
  }
  for (const task of completed) {
    registry.publishToUsers([userId], { op: 'task:complete', d: task });
  }
}

/**
 * Everything a sent message is worth, behind one catch.
 *
 * The scoring for a message is three awaits, and `progress` guards only its own.
 * Called as a floating promise - which is the point, since none of it should
 * delay delivering the message - an error in either of the other two becomes an
 * unhandled rejection, and an unhandled rejection ends the process. It did:
 * one bad parameter in the cooldown query took the whole gateway down and
 * disconnected everyone on it.
 *
 * So the entire sequence lives here, behind one catch, and callers have exactly
 * one thing to remember instead of three.
 */
export async function scoreMessage(userId: string): Promise<void> {
  try {
    await touchStreak(userId);
    const earns = await claimMessageXp(userId);
    await progress(userId, 'message', earns ? randomMessageXp() : 0);
    // Streak tasks are only worth re-checking on a day the person did something
    // that counted.
    if (earns) await progress(userId, 'daily');
  } catch (error) {
    console.error('[progress] scoring a message failed', { userId, error });
  }
}

/** What the client needs to draw somebody's level. */
export async function progressFor(userId: string): Promise<{
  xp: number;
  level: number;
  intoLevel: number;
  needed: number;
  streak: number;
  completedTaskIds: string[];
}> {
  const stats = await ensureStats(userId);
  const { level, intoLevel, needed } = levelFromXp(stats.xp);
  return {
    xp: stats.xp,
    level,
    intoLevel,
    needed,
    streak: stats.currentStreak,
    completedTaskIds: [...(await completedTaskIds(userId))],
  };
}

/** Level only, for the people shown beside you. */
export async function levelOf(userId: string): Promise<number> {
  const stats = await ensureStats(userId);
  return levelFromXp(stats.xp).level;
}

export type { PublicUser };
