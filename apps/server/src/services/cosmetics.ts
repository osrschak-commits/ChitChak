import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ownedCosmetics } from '../db/schema.js';
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

  // --- Badges: a small mark beside your name --------------------------------
  {
    id: 'badge.founder',
    name: 'Founder',
    slot: 'badge',
    blurb: 'For being here before it was finished.',
    price: 6,
    value: '◆',
  },
  {
    id: 'badge.meter',
    name: 'Meter',
    slot: 'badge',
    blurb: 'Three bars, the mark this app is named after.',
    price: 3,
    value: '▮▮▮',
  },
  {
    id: 'badge.dot',
    name: 'On air',
    slot: 'badge',
    blurb: 'The lamp above a studio door.',
    price: 3,
    value: '●',
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

    if (item.requiresSubscription) {
      const standing = await standingOf(userId);
      if (!standing.active) throw errors.forbidden('That comes with a subscription');
    } else if (!(await owns(userId, cosmeticId))) {
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
export async function wornBy(userId: string): Promise<Record<Slot, string | null>> {
  const rows = await db
    .select()
    .from(ownedCosmetics)
    .where(and(eq(ownedCosmetics.userId, userId), eq(ownedCosmetics.equipped, true)));

  const worn: Record<Slot, string | null> = { plate: null, badge: null };
  if (rows.length === 0) return worn;

  const items = rows
    .map((row) => COSMETICS_BY_ID.get(row.cosmeticId))
    .filter((item): item is Cosmetic => Boolean(item));

  // Only asked when something worn actually depends on it.
  const needsSubscription = items.some((item) => item.requiresSubscription);
  const subscribed = needsSubscription ? (await standingOf(userId)).active : false;

  for (const item of items) {
    if (item.requiresSubscription && !subscribed) continue;
    worn[item.slot] = item.value;
  }
  return worn;
}
