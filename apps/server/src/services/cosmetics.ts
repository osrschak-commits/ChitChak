import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ownedCosmetics, users } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import * as keys from './keys.js';
import { standingOf } from './subscriptions.js';

/**
 * The cosmetics catalogue.
 *
 * Code, not rows - the same reasoning as the task catalogue. What a cosmetic is
 * worth and what it looks like are decisions that ship with a release, and a
 * database table pretending to be configuration is a way to have half of them
 * live in migrations and half in the client.
 *
 * What *is* stored is only who owns what, and which one they are wearing.
 *
 * Every item here is decoration and nothing else. Nothing bought with keys
 * changes what somebody can do, what they can see, or how loud they are - the
 * moment money buys permission, moderation becomes a pricing question.
 */

/** One thing may be worn per slot. */
export type Slot = 'plate' | 'badge';

/**
 * How often a chest gives one out. Nothing else depends on it.
 *
 * Deliberately not a price and not a quality ranking. A common plate somebody
 * actually wears is worth more to them than a legendary they never equip, and
 * the moment rarity is wired to a number the catalogue starts being designed
 * around the number rather than around what looks good.
 */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface Cosmetic {
  id: string;
  name: string;
  slot: Slot;
  /** Shown in the shop, under the name. */
  blurb: string;
  /**
   * In chak keys. Zero for anything a subscription includes, which is not the
   * same as free - see `requiresSubscription`.
   */
  price: number;
  /**
   * Included with a subscription rather than bought.
   *
   * These are never owned. Being subscribed is the entitlement, so there is no
   * purchase, no ownership row, and nothing to take away when a subscription
   * lapses - it simply stops applying, and comes back if they subscribe again.
   * That is also why lapsing needs no scheduled job: it is a question asked at
   * the moment somebody is drawn, not a state to keep up to date.
   */
  requiresSubscription?: boolean;
  /**
   * How the client draws it. Deliberately data rather than a class name: the
   * client decides how to render a finish, but which finish is the server's.
   */
  value: string;
  /**
   * Which tier of the chest it comes out of.
   *
   * Absent means it is not in the chest at all - the subscription plates are
   * included with Brass and would be a strange thing to also win.
   */
  rarity?: Rarity;
  /**
   * Given, never sold and never won.
   *
   * A badge that says "you were here first" is worth exactly as much as the
   * claim is true, so it cannot also be something a latecomer buys or rolls
   * for. These are handed out by `award`, refused by `buy`, and kept out of
   * the chest pool; the shop only shows one to somebody who already has it, so
   * it can be worn from the same place as everything else.
   */
  awarded?: boolean;
  /**
   * Earned by having had an account this long, and by nothing else.
   *
   * Derived rather than granted, for the same reason the subscription plates
   * are: it is a question with an answer at the moment somebody is drawn, so
   * there is no scheduled job to fail overnight, nothing to be out of date,
   * and no way for the badge to appear a day late because a sweep was slow.
   * Nobody owns one - the account's age is the entitlement.
   */
  earnedAfterDays?: number;
}

export const COSMETICS: Cosmetic[] = [
  // --- Plates: the finish on your profile card ------------------------------
  {
    id: 'plate.brass',
    name: 'Brass plate',
    slot: 'plate',
    blurb: 'The warm metal the rest of the app is trimmed with.',
    price: 0,
    requiresSubscription: true,
    value: 'linear-gradient(135deg, #d9a45b, #8a6a33)',
  },
  {
    id: 'plate.signal',
    name: 'Signal plate',
    slot: 'plate',
    blurb: 'The colour reserved everywhere else for live audio.',
    price: 0,
    requiresSubscription: true,
    value: 'linear-gradient(135deg, #4fd6c4, #2b7f76)',
  },
  {
    id: 'plate.graphite',
    name: 'Graphite plate',
    slot: 'plate',
    blurb: 'Machined, dark, and quiet about it.',
    price: 0,
    requiresSubscription: true,
    value: 'linear-gradient(135deg, #3a3742, #17161a)',
  },
  {
    id: 'plate.oxblood',
    name: 'Oxblood plate',
    slot: 'plate',
    blurb: 'Deep red, the colour of an old mixing desk.',
    price: 0,
    requiresSubscription: true,
    value: 'linear-gradient(135deg, #7d2f34, #3a1417)',
  },

  /*
    --- Badges nobody can buy ------------------------------------------------

    These are records of when somebody turned up, and a record that can be
    bought later is not a record of anything - so they are out of the shop and
    out of the chest, which is what `awarded` means.

    They are earned two different ways. Founder is handed out at registration
    while `PRE_LAUNCH` is on, and stops for good the day it is turned off. Year
    one is not handed out at all: it is a question asked about the account's
    age, so it appears on its own the day it is true.
  */
  {
    id: 'badge.founder',
    name: 'Founder',
    slot: 'badge',
    blurb: 'Here before it was finished. Given, never sold.',
    price: 0,
    awarded: true,
    value: '◆',
  },
  {
    id: 'badge.1year',
    name: 'Year one',
    slot: 'badge',
    blurb: 'A year on ChitChak, to the day.',
    price: 0,
    awarded: true,
    earnedAfterDays: 365,
    value: '❶',
  },

  // --- Badges: a small mark beside your name --------------------------------
  {
    id: 'badge.meter',
    name: 'Meter',
    slot: 'badge',
    blurb: 'Three bars, the mark this app is named after.',
    price: 3,
    rarity: 'uncommon',
    value: '▮▮▮',
  },
  {
    id: 'badge.dot',
    name: 'On air',
    slot: 'badge',
    blurb: 'The lamp above a studio door.',
    price: 3,
    rarity: 'common',
    value: '●',
  },

  /*
    The rest of the chest.

    Bought as well as won on purpose: somebody who wants one specific thing
    should be able to go and get it rather than roll for it, which is the
    difference between a shop with a chest in it and a chest with a shop
    attached. Prices climb with rarity because a rarer item is a longer wait,
    not because it is better.
  */
  {
    id: 'badge.wave',
    name: 'Wave',
    slot: 'badge',
    blurb: 'A signal, moving.',
    price: 3,
    rarity: 'common',
    value: '〜',
  },
  {
    id: 'badge.pin',
    name: 'Pin',
    slot: 'badge',
    blurb: 'For the ones who never miss a thread.',
    price: 3,
    rarity: 'common',
    value: '✦',
  },
  {
    id: 'badge.cassette',
    name: 'Cassette',
    slot: 'badge',
    blurb: 'Rewound, taped over, handed round.',
    price: 4,
    rarity: 'uncommon',
    value: '⊞',
  },
  {
    id: 'badge.night',
    name: 'Night shift',
    slot: 'badge',
    blurb: 'Still here at four in the morning.',
    price: 4,
    rarity: 'uncommon',
    value: '☾',
  },
  {
    id: 'badge.antenna',
    name: 'Antenna',
    slot: 'badge',
    blurb: 'Picks up everything, says little.',
    price: 6,
    rarity: 'rare',
    value: '⟟',
  },
  {
    id: 'badge.relay',
    name: 'Relay',
    slot: 'badge',
    blurb: 'Passes it on without dropping a word.',
    price: 6,
    rarity: 'rare',
    value: '⇄',
  },
  {
    id: 'badge.eclipse',
    name: 'Eclipse',
    slot: 'badge',
    blurb: 'Rare, brief, and worth looking up for.',
    price: 10,
    rarity: 'epic',
    value: '◑',
  },
  {
    id: 'badge.crown',
    name: 'Brass crown',
    slot: 'badge',
    blurb: 'Not awarded. Found.',
    price: 16,
    rarity: 'legendary',
    value: '♛',
  },

  // --- Plates that are won rather than included ----------------------------
  {
    id: 'plate.slate',
    name: 'Slate plate',
    slot: 'plate',
    blurb: 'Wet stone, and nothing else.',
    price: 4,
    rarity: 'common',
    value: 'linear-gradient(135deg, #4a4f57, #23262b)',
  },
  {
    id: 'plate.moss',
    name: 'Moss plate',
    slot: 'plate',
    blurb: 'The green that grows on the north side.',
    price: 4,
    rarity: 'common',
    value: 'linear-gradient(135deg, #5c7052, #2c3a28)',
  },
  {
    id: 'plate.tide',
    name: 'Tide plate',
    slot: 'plate',
    blurb: 'Cold water under a grey sky.',
    price: 5,
    rarity: 'uncommon',
    value: 'linear-gradient(135deg, #43708f, #1d3243)',
  },
  {
    id: 'plate.ember',
    name: 'Ember plate',
    slot: 'plate',
    blurb: 'The last hour of a fire.',
    price: 7,
    rarity: 'rare',
    value: 'linear-gradient(135deg, #c96a3a, #5a2416)',
  },
  {
    id: 'plate.aurora',
    name: 'Aurora plate',
    slot: 'plate',
    blurb: 'Seen once, described badly ever after.',
    price: 12,
    rarity: 'epic',
    value: 'linear-gradient(135deg, #4fd6c4, #8a7fd4 55%, #d97b6c)',
  },
];

export const COSMETICS_BY_ID = new Map(COSMETICS.map((item) => [item.id, item]));

export interface Owned {
  cosmeticId: string;
  equipped: boolean;
}

export async function ownedBy(userId: string): Promise<Owned[]> {
  const rows = await db
    .select()
    .from(ownedCosmetics)
    .where(eq(ownedCosmetics.userId, userId));
  // Anything whose id has since left the catalogue is dropped from the answer
  // rather than shown as a blank: a removed cosmetic should stop appearing, not
  // become a mystery entry nobody can explain.
  return rows
    .filter((row) => COSMETICS_BY_ID.has(row.cosmeticId))
    .map((row) => ({ cosmeticId: row.cosmeticId, equipped: row.equipped }));
}

/**
 * Buy one, once.
 *
 * The ownership row is written before the keys are taken, and its primary key
 * is what stops a double purchase: a second attempt conflicts, writes nothing,
 * and never reaches the spend. Doing it the other way round would take the keys
 * first and then discover the person already owned it.
 */
export async function buy(userId: string, cosmeticId: string): Promise<void> {
  const item = COSMETICS_BY_ID.get(cosmeticId);
  if (!item) throw errors.notFound('No such item');
  if (item.requiresSubscription) {
    throw errors.invalid('That comes with a subscription rather than being bought');
  }
  if (item.awarded) throw errors.invalid('That one is given out, not sold');

  const claimed = await db
    .insert(ownedCosmetics)
    .values({ userId, cosmeticId })
    .onConflictDoNothing()
    .returning({ cosmeticId: ownedCosmetics.cosmeticId });

  if (claimed.length === 0) throw errors.invalid('You already own that');

  try {
    await keys.spend({ userId, amount: item.price, reference: cosmeticId });
  } catch (error) {
    // Could not pay for it, so they do not have it. Undoing the claim rather
    // than leaving a free item behind - and this is the only path that can
    // reach here, since the row was written moments ago by this request.
    await db
      .delete(ownedCosmetics)
      .where(and(eq(ownedCosmetics.userId, userId), eq(ownedCosmetics.cosmeticId, cosmeticId)));
    throw error;
  }
}

/**
 * The badges handed to every account that exists before launch.
 *
 * Listed here rather than derived from `awarded`, because the two are not the
 * same question: `awarded` says an item cannot be bought, and this says which
 * ones are currently being given away. A badge retired at launch keeps the
 * first and leaves the second.
 */
export const AWARDED_AT_SIGNUP = ['badge.founder'] as const;

/** Whole days since the account was made. */
export async function accountAgeDays(userId: string): Promise<number> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { createdAt: true },
  });
  if (!row) return 0;
  return Math.floor((Date.now() - row.createdAt.getTime()) / 86_400_000);
}

/**
 * Whether somebody may wear this right now.
 *
 * The two derived entitlements are asked lazily and only when something worn
 * actually depends on one, so drawing a name costs no extra queries in the
 * ordinary case where nobody is wearing a subscription plate or a time badge.
 */
async function entitled(
  userId: string,
  item: Cosmetic,
  cache: { subscribed?: boolean; ageDays?: number },
): Promise<boolean> {
  if (item.requiresSubscription) {
    cache.subscribed ??= (await standingOf(userId)).active;
    return cache.subscribed;
  }
  if (item.earnedAfterDays !== undefined) {
    cache.ageDays ??= await accountAgeDays(userId);
    return cache.ageDays >= item.earnedAfterDays;
  }
  return owns(userId, item.id);
}

/**
 * Give somebody a cosmetic without taking anything for it.
 *
 * Returns whether this granted it, so a caller can tell "given" from "already
 * had", and so running a backfill twice reports honestly the second time.
 * Nothing is spent, so unlike `buy` there is no failure that has to be undone.
 */
export async function award(userId: string, cosmeticId: string): Promise<boolean> {
  if (!COSMETICS_BY_ID.has(cosmeticId)) throw errors.notFound('No such item');

  const claimed = await db
    .insert(ownedCosmetics)
    .values({ userId, cosmeticId })
    .onConflictDoNothing()
    .returning({ cosmeticId: ownedCosmetics.cosmeticId });

  return claimed.length > 0;
}

/**
 * Wear one, or take it off.
 *
 * At most one per slot, enforced by clearing the slot first. A unique index
 * could say the same thing, but only as a failure - and "you are already
 * wearing a badge" is not a thing anyone should have to be told.
 */
export async function equip(userId: string, cosmeticId: string | null, slot: Slot): Promise<void> {
  if (cosmeticId !== null) {
    const item = COSMETICS_BY_ID.get(cosmeticId);
    if (!item) throw errors.notFound('No such item');
    if (item.slot !== slot) throw errors.invalid('That does not go there');

    if (!(await entitled(userId, item, {}))) {
      if (item.requiresSubscription) throw errors.forbidden('That comes with a subscription');
      if (item.earnedAfterDays !== undefined) {
        throw errors.forbidden('You have not had an account that long yet');
      }
      throw errors.forbidden('You do not own that');
    }
  }

  /**
   * A row per worn thing, whether or not it was bought.
   *
   * Subscription items are not owned, but wearing one still has to be recorded
   * somewhere - so the row exists to remember the choice, and `wornBy` decides
   * whether it currently applies. That keeps a lapsed subscriber's plate
   * remembered rather than forgotten, so resubscribing puts it back rather than
   * making them pick again.
   */
  const inSlot = (await ownedBy(userId))
    .filter((row) => COSMETICS_BY_ID.get(row.cosmeticId)?.slot === slot)
    .map((row) => row.cosmeticId);

  await db.transaction(async (tx) => {
    for (const id of inSlot) {
      await tx
        .update(ownedCosmetics)
        .set({ equipped: false })
        .where(and(eq(ownedCosmetics.userId, userId), eq(ownedCosmetics.cosmeticId, id)));
    }
    if (cosmeticId !== null) {
      await tx
        .insert(ownedCosmetics)
        .values({ userId, cosmeticId, equipped: true })
        .onConflictDoUpdate({
          target: [ownedCosmetics.userId, ownedCosmetics.cosmeticId],
          set: { equipped: true },
        });
    }
  });
}

async function owns(userId: string, cosmeticId: string): Promise<boolean> {
  const row = await db.query.ownedCosmetics.findFirst({
    where: and(eq(ownedCosmetics.userId, userId), eq(ownedCosmetics.cosmeticId, cosmeticId)),
  });
  return Boolean(row);
}

/**
 * What somebody is wearing, for everyone else to draw.
 *
 * A subscription item is only worn while the subscription is current. Asking
 * here rather than clearing rows when one lapses means there is no scheduled
 * job to get wrong, nothing to be out of date, and the choice survives - a
 * lapsed subscriber's plate reappears the moment they subscribe again.
 */
export interface WornBadge {
  /** So the client can find the artwork for it. */
  id: string;
  name: string;
  /** Shown when somebody hovers it - what this badge is for. */
  blurb: string;
  /** The glyph, still sent: it is what a client without the artwork draws. */
  value: string;
  rarity?: Rarity;
}

export interface Worn {
  /** A CSS background, or null. Plates have nothing to describe. */
  plate: string | null;
  /**
   * The badge itself rather than its glyph.
   *
   * A mark beside a name that nobody can identify is decoration; the point of
   * a badge is that it says something, so it has to carry what it says. The
   * catalogue lives on the server, so the alternative would be shipping it to
   * every client to look up one string.
   */
  badge: WornBadge | null;
}

export async function wornBy(userId: string): Promise<Worn> {
  const rows = await db
    .select()
    .from(ownedCosmetics)
    .where(and(eq(ownedCosmetics.userId, userId), eq(ownedCosmetics.equipped, true)));

  const worn: Worn = { plate: null, badge: null };
  if (rows.length === 0) return worn;

  const items = rows
    .map((row) => COSMETICS_BY_ID.get(row.cosmeticId))
    .filter((item): item is Cosmetic => Boolean(item));

  // Asked at most once each, and only if something worn depends on it.
  const cache: { subscribed?: boolean; ageDays?: number } = {};

  for (const item of items) {
    // Ownership is already proved by the row being here and equipped, so the
    // only questions left are the derived ones.
    if (
      (item.requiresSubscription || item.earnedAfterDays !== undefined) &&
      !(await entitled(userId, item, cache))
    ) {
      continue;
    }
    if (item.slot === 'plate') {
      worn.plate = item.value;
    } else {
      worn.badge = {
        id: item.id,
        name: item.name,
        blurb: item.blurb,
        value: item.value,
        ...(item.rarity ? { rarity: item.rarity } : {}),
      };
    }
  }
  return worn;
}
