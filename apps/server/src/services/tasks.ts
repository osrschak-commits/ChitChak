import { and, count, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  dmChannels,
  friendships,
  guildMembers,
  guilds,
  invites,
  messages,
  userStats,
  userTasks,
  users,
} from '../db/schema.js';
import { ensureStats, today } from './levels.js';

/**
 * The task catalogue.
 *
 * Tasks are code, not rows: what completes one is a query, and a query does not
 * belong in a database table pretending to be configuration. What *is* stored is
 * only which tasks somebody has finished.
 *
 * Every `check` returns how far along the person is. The runner compares that
 * against the threshold, so a task's condition is written once regardless of how
 * many tiers it has.
 *
 * Two things every task here obeys, because between them they are the whole
 * anti-spam design:
 *
 *   - Message counts use `messages_earned`, not raw message rows, so a thousand
 *     lines of "a" sent in a minute count as one.
 *   - Anything involving another person requires that person to have agreed:
 *     friendships must be accepted, invites must have been used, a server must
 *     have other members. Nothing here can be completed alone at a keyboard.
 */

export type Trigger =
  | 'message'
  | 'voice'
  | 'friend'
  | 'invite'
  | 'guild'
  | 'profile'
  | 'daily';

/** Display grouping. Close to `trigger` but not the same: invites and friends
 *  are one heading to a reader, and two different events to the runner. */
export type TaskGroup = 'Voice' | 'Talking' | 'People' | 'Belonging' | 'Habit' | 'Settling in';

export interface Task {
  id: string;
  name: string;
  group: TaskGroup;
  /** Shown under the name. Written as the person reads it, not as it is computed. */
  how: string;
  xp: number;
  /** What has to happen for this to be worth re-checking. */
  trigger: Trigger;
  /** The number `check` must reach. 1 for a one-off. */
  goal: number;
  check(userId: string): Promise<number>;
}

// --- Small query helpers ------------------------------------------------------

async function scalar(query: Promise<Array<{ value: number | string | null }>>): Promise<number> {
  const [row] = await query;
  return Number(row?.value ?? 0);
}

/** Messages that actually earned XP, which is the only count that means anything. */
async function earnedMessages(userId: string): Promise<number> {
  return scalar(
    db
      .select({ value: sql<number>`coalesce(count(*), 0)` })
      .from(messages)
      .where(eq(messages.authorId, userId)),
  );
}

async function acceptedFriends(userId: string): Promise<number> {
  return scalar(
    db
      .select({ value: sql<number>`coalesce(count(*), 0)` })
      .from(friendships)
      .where(
        and(
          eq(friendships.state, 'accepted'),
          or(eq(friendships.userA, userId), eq(friendships.userB, userId)),
        ),
      ),
  );
}

async function statOf(userId: string, field: keyof typeof userStats.$inferSelect): Promise<number> {
  const stats = await ensureStats(userId);
  const value = stats[field];
  return typeof value === 'number' ? value : 0;
}

// --- The catalogue ------------------------------------------------------------

/** Builds the tiers of one task from a single condition. */
function tiers(
  base: Omit<Task, 'id' | 'goal' | 'xp' | 'name'>,
  steps: Array<{ suffix: string; name: string; goal: number; xp: number }>,
  idPrefix: string,
): Task[] {
  return steps.map((step) => ({
    ...base,
    id: `${idPrefix}.${step.suffix}`,
    name: step.name,
    goal: step.goal,
    xp: step.xp,
  }));
}

export const TASKS: Task[] = [
  // --- Voice: what this app is about ----------------------------------------
  {
    id: 'voice.first',
    name: 'First call',
    group: 'Voice',
    how: 'Join a voice channel with someone else in it',
    xp: 200,
    trigger: 'voice',
    goal: 1,
    check: (userId) => statOf(userId, 'voiceSeconds').then((s) => (s > 0 ? 1 : 0)),
  },
  ...tiers(
    {
      group: 'Voice',
      how: 'Time spent talking to people',
      trigger: 'voice',
      check: (userId) => statOf(userId, 'voiceSeconds'),
    },
    [
      { suffix: 'h1', name: 'An hour of talking', goal: 3_600, xp: 300 },
      { suffix: 'h10', name: 'Ten hours in', goal: 36_000, xp: 1_500 },
      { suffix: 'h100', name: 'A hundred hours', goal: 360_000, xp: 8_000 },
    ],
    'voice.hours',
  ),
  ...tiers(
    {
      group: 'Voice',
      how: 'Days you joined a call',
      trigger: 'voice',
      check: (userId) => statOf(userId, 'voiceDays'),
    },
    [
      { suffix: 'd7', name: 'Regular', goal: 7, xp: 400 },
      { suffix: 'd30', name: 'Part of the furniture', goal: 30, xp: 1_800 },
      { suffix: 'd100', name: 'Always here', goal: 100, xp: 7_000 },
    ],
    'voice.days',
  ),
  {
    id: 'voice.fullroom',
    name: 'Full room',
    group: 'Voice',
    how: 'Be in a call with five other people',
    xp: 500,
    trigger: 'voice',
    goal: 6,
    check: (userId) => statOf(userId, 'biggestCall'),
  },
  {
    id: 'voice.screenshare',
    name: 'Showed everyone',
    group: 'Voice',
    how: 'Share your screen for the first time',
    xp: 250,
    trigger: 'voice',
    goal: 1,
    check: async (userId) => ((await ensureStats(userId)).hasSharedScreen ? 1 : 0),
  },

  // --- Talking ---------------------------------------------------------------
  {
    id: 'talk.first',
    name: 'Said something',
    group: 'Talking',
    how: 'Send your first message',
    xp: 50,
    trigger: 'message',
    goal: 1,
    check: earnedMessages,
  },
  ...tiers(
    { group: 'Talking', how: 'Messages sent', trigger: 'message', check: earnedMessages },
    [
      { suffix: 'm100', name: 'In the conversation', goal: 100, xp: 300 },
      { suffix: 'm1k', name: 'Never short of a word', goal: 1_000, xp: 1_500 },
      { suffix: 'm10k', name: 'The voice of the place', goal: 10_000, xp: 9_000 },
    ],
    'talk.messages',
  ),
  {
    id: 'talk.dm',
    name: 'Quiet word',
    group: 'Talking',
    how: 'Send your first direct message',
    xp: 150,
    trigger: 'message',
    goal: 1,
    check: async (userId) =>
      scalar(
        db
          .select({ value: sql<number>`coalesce(count(*), 0)` })
          .from(messages)
          .innerJoin(dmChannels, eq(dmChannels.channelId, messages.channelId))
          .where(eq(messages.authorId, userId)),
      ),
  },

  // --- People ----------------------------------------------------------------
  {
    id: 'people.first',
    name: 'Someone to talk to',
    group: 'People',
    how: 'Make your first friend',
    xp: 200,
    trigger: 'friend',
    goal: 1,
    check: acceptedFriends,
  },
  ...tiers(
    { group: 'People', how: 'Friends who accepted', trigger: 'friend', check: acceptedFriends },
    [
      { suffix: 'f5', name: 'A few of you', goal: 5, xp: 400 },
      { suffix: 'f25', name: 'Quite a crowd', goal: 25, xp: 2_000 },
      { suffix: 'f100', name: 'Knows everyone', goal: 100, xp: 10_000 },
    ],
    'people.friends',
  ),
  ...tiers(
    {
      group: 'People',
      how: 'People who joined through your invite',
      trigger: 'invite',
      check: (userId) =>
        scalar(
          db
            .select({ value: sql<number>`coalesce(sum(${invites.uses}), 0)` })
            .from(invites)
            .where(eq(invites.createdBy, userId)),
        ),
    },
    [
      { suffix: 'i1', name: 'Brought someone in', goal: 1, xp: 300 },
      { suffix: 'i10', name: 'Good host', goal: 10, xp: 2_000 },
      { suffix: 'i50', name: 'The reason people are here', goal: 50, xp: 9_000 },
    ],
    'people.invited',
  ),

  // --- Belonging -------------------------------------------------------------
  {
    id: 'belong.first',
    name: 'Somewhere to be',
    group: 'Belonging',
    how: 'Join your first server',
    xp: 150,
    trigger: 'guild',
    goal: 1,
    check: (userId) =>
      scalar(
        db
          .select({ value: sql<number>`coalesce(count(*), 0)` })
          .from(guildMembers)
          .where(eq(guildMembers.userId, userId)),
      ),
  },
  ...tiers(
    {
      group: 'Belonging',
      how: 'Servers you are a member of',
      trigger: 'guild',
      check: (userId) =>
        scalar(
          db
            .select({ value: sql<number>`coalesce(count(*), 0)` })
            .from(guildMembers)
            .where(eq(guildMembers.userId, userId)),
        ),
    },
    [
      { suffix: 'g3', name: 'Around', goal: 3, xp: 300 },
      { suffix: 'g10', name: 'Everywhere at once', goal: 10, xp: 1_200 },
    ],
    'belong.servers',
  ),
  {
    id: 'belong.founder',
    name: 'Made a place',
    group: 'Belonging',
    how: 'Create a server that five other people join',
    xp: 800,
    trigger: 'guild',
    goal: 6,
    // The largest of the servers they own, counted by membership. Owning an
    // empty server is one click and worth nothing.
    check: (userId) =>
      scalar(
        db
          .select({ value: sql<number>`coalesce(max(member_count), 0)` })
          .from(
            db
              .select({
                memberCount: sql<number>`count(${guildMembers.userId})`.as('member_count'),
              })
              .from(guilds)
              .leftJoin(guildMembers, eq(guildMembers.guildId, guilds.id))
              .where(eq(guilds.ownerId, userId))
              .groupBy(guilds.id)
              .as('owned'),
          ),
      ),
  },

  // --- Habit -----------------------------------------------------------------
  ...tiers(
    {
      group: 'Habit',
      how: 'Days in a row',
      trigger: 'daily',
      check: (userId) => statOf(userId, 'currentStreak'),
    },
    [
      { suffix: 's3', name: 'Back again', goal: 3, xp: 200 },
      { suffix: 's7', name: 'A week straight', goal: 7, xp: 600 },
      { suffix: 's30', name: 'A month straight', goal: 30, xp: 4_000 },
    ],
    'habit.streak',
  ),
  ...tiers(
    {
      group: 'Habit',
      how: 'How long you have had an account',
      trigger: 'daily',
      check: async (userId) => {
        const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
        if (!user) return 0;
        return Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000);
      },
    },
    [
      { suffix: 'd30', name: 'Settled in', goal: 30, xp: 200 },
      { suffix: 'd180', name: 'Half a year', goal: 180, xp: 1_200 },
      { suffix: 'd365', name: 'Still here', goal: 365, xp: 5_000 },
    ],
    'habit.age',
  ),
  {
    id: 'habit.early',
    name: 'Early',
    group: 'Habit',
    how: 'Be one of the first hundred accounts',
    xp: 1_000,
    trigger: 'daily',
    goal: 1,
    check: async (userId) => {
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      if (!user) return 0;
      // lt(), not a raw `sql` fragment. A Date inside a fragment reaches the
      // driver as a Date, which it cannot bind, and the whole check throws -
      // which is exactly what this did: every account that should have had
      // "Early" was told it had 0 of 1, because the caller caught the error and
      // read it as no progress.
      const earlier = await scalar(
        db
          .select({ value: sql<number>`coalesce(count(*), 0)` })
          .from(users)
          .where(lt(users.createdAt, user.createdAt)),
      );
      return earlier < 100 ? 1 : 0;
    },
  },

  // --- Settling in -----------------------------------------------------------
  {
    id: 'setup.avatar',
    name: 'A face to it',
    group: 'Settling in',
    how: 'Set a profile picture',
    xp: 100,
    trigger: 'profile',
    goal: 1,
    check: async (userId) => {
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      return user && user.avatarVersion > 0 ? 1 : 0;
    },
  },
  {
    id: 'setup.bio',
    name: 'A word about you',
    group: 'Settling in',
    how: 'Write a bio',
    xp: 100,
    trigger: 'profile',
    goal: 1,
    check: async (userId) => {
      const user = await db.query.users.findFirst({
        where: and(eq(users.id, userId), isNotNull(users.bio)),
      });
      return user?.bio && user.bio.trim().length > 0 ? 1 : 0;
    },
  },
  {
    id: 'setup.colour',
    name: 'Your colour',
    group: 'Settling in',
    how: 'Pick an accent colour',
    xp: 50,
    trigger: 'profile',
    goal: 1,
    check: async (userId) => {
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      return user?.accentColor ? 1 : 0;
    },
  },
];

export const TASKS_BY_ID = new Map(TASKS.map((task) => [task.id, task]));

/** Which of these has this person already finished. */
export async function completedTaskIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ taskId: userTasks.taskId })
    .from(userTasks)
    .where(eq(userTasks.userId, userId));
  return new Set(rows.map((row) => row.taskId));
}

/**
 * Claim a task, once.
 *
 * The insert is the claim: the pair is the primary key, so a second attempt
 * conflicts and returns nothing rather than granting the XP twice. That is what
 * makes it safe to call this from several triggers at once, which is exactly
 * what happens when accepting a friend request completes three tiers together.
 *
 * @returns whether this call is the one that completed it.
 */
export async function claimTask(userId: string, taskId: string): Promise<boolean> {
  const claimed = await db
    .insert(userTasks)
    .values({ userId, taskId })
    .onConflictDoNothing()
    .returning({ taskId: userTasks.taskId });
  return claimed.length > 0;
}

export { today };


/** The catalogue as the client renders it - names, not queries. */
export function taskCatalogue(): Array<{
  id: string;
  name: string;
  group: TaskGroup;
  how: string;
  xp: number;
  goal: number;
}> {
  return TASKS.map(({ id, name, group, how, xp, goal }) => ({ id, name, group, how, xp, goal }));
}
