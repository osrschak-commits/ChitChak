import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userStats, voiceStates } from '../db/schema.js';
import { ensureStats, today, VOICE_XP_PER_MINUTE } from '../services/levels.js';
import { progress } from '../services/progress.js';

/**
 * Voice time, counted a minute at a time.
 *
 * `voice_states` is the present tense: one row per person, deleted when they
 * leave. Nothing records that a call happened, so time in calls cannot be
 * reconstructed after the fact - it has to be counted while it is happening.
 *
 * A ticker rather than arithmetic on leave, and that is the important choice.
 * Working out a duration from a join timestamp looks simpler until the rules
 * arrive: time only counts while somebody else is in the room, and not while
 * you are deafened. Both change during a call, several times, so a subtraction
 * at the end would need a log of every change to be correct - which is a
 * ticker, written awkwardly. Sampling once a minute answers the question
 * directly: who is, right now, in a call that counts.
 *
 * Being sampled, it is approximate at the edges - a fifty-second call earns
 * nothing. That is the right way round: it under-counts rather than paying for
 * time nobody spent.
 */

const TICK_MS = 60_000;
/** Below this, nobody in the channel is talking to anybody. */
const MINIMUM_PARTICIPANTS = 2;

let timer: NodeJS.Timeout | undefined;

export function startVoiceXpTicker(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick().catch(() => {
      // Scoring must never take the gateway down with it.
    });
  }, TICK_MS);
  // Do not hold the process open at shutdown for the sake of a scoring timer.
  timer.unref?.();
}

export function stopVoiceXpTicker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

/** Exported for the tests and for a manual nudge; safe to call at any time. */
export async function tick(): Promise<void> {
  const present = await db
    .select({
      userId: voiceStates.userId,
      channelId: voiceStates.channelId,
      selfDeafened: voiceStates.selfDeafened,
      serverDeafened: voiceStates.serverDeafened,
    })
    .from(voiceStates);

  if (present.length === 0) return;

  const byChannel = new Map<string, typeof present>();
  for (const state of present) {
    const list = byChannel.get(state.channelId) ?? [];
    list.push(state);
    byChannel.set(state.channelId, list);
  }

  const day = today();

  for (const [, occupants] of byChannel) {
    // Sitting alone in a channel is not a conversation, and paying for it would
    // make an empty room the most efficient way to level up.
    if (occupants.length < MINIMUM_PARTICIPANTS) continue;

    for (const occupant of occupants) {
      // Deafened means not listening. Whether they chose it or a moderator did
      // makes no difference to whether they are taking part.
      if (occupant.selfDeafened || occupant.serverDeafened) continue;

      await creditMinute(occupant.userId, day, occupants.length);
    }
  }
}

async function creditMinute(userId: string, day: string, callSize: number): Promise<void> {
  await ensureStats(userId);

  await db
    .update(userStats)
    .set({
      voiceSeconds: sql`${userStats.voiceSeconds} + 60`,
      // A day is counted once: the increment only applies when the stored date
      // is not today, and the same statement moves the date forward.
      voiceDays: sql`case when ${userStats.lastVoiceDate} is distinct from ${day}::date then ${userStats.voiceDays} + 1 else ${userStats.voiceDays} end`,
      lastVoiceDate: sql`${day}::date`,
      // High-water mark, so "in a call with five others" survives everyone
      // leaving afterwards.
      biggestCall: sql`greatest(${userStats.biggestCall}, ${callSize})`,
      updatedAt: new Date(),
    })
    .where(eq(userStats.userId, userId));

  await progress(userId, 'voice', VOICE_XP_PER_MINUTE);
}

/** Called when somebody starts sharing, for the one-off task. */
export async function noteScreenShare(userId: string): Promise<void> {
  await ensureStats(userId);
  await db
    .update(userStats)
    .set({ hasSharedScreen: true, updatedAt: new Date() })
    .where(eq(userStats.userId, userId));
  await progress(userId, 'voice');
}
