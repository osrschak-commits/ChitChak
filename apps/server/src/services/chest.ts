import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ownedCosmetics } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import { COSMETICS, type Cosmetic, type Rarity } from './cosmetics.js';
import * as keys from './keys.js';

/**
 * The brass chest: a key in, a cosmetic out.
 *
 * Three things here are deliberate and are the whole design.
 *
 * **The roll happens on the server, from a cryptographic source.** The client
 * is told what it won and plays an animation; it never decides. `Math.random`
 * is not used, not because anyone would predict it, but because the one place
 * a random number decides who gets what is the place worth being exact about.
 *
 * **What comes out is bound to the account.** There is no transfer, no trade
 * and no way to turn a cosmetic back into money. That is not an omission - it
 * is the line that keeps this a collection rather than a market. CS:GO's
 * problem was never that Valve sold cash-out; Steam paid in wallet funds that
 * cannot be withdrawn. It was that skins could move between accounts, and
 * other people built the cash layer on top of that. Nothing here moves.
 *
 * **You cannot win something you already own.** Duplicates exist to give a
 * marketplace something to trade, and there is no marketplace - so a duplicate
 * would just be a key spent on nothing. When trading is decided, this is the
 * assumption to revisit first.
 */

/** What one chest costs. */
export const CHEST_COST = 1;

/**
 * The published odds.
 *
 * Shown in the app, and exported so the interface reads the same numbers the
 * roll uses rather than a copy that can drift away from them.
 */
export const DROP_RATES: Record<Rarity, number> = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1,
};

const TIERS: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** Everything the chest can ever give. */
export const CHEST_POOL: Cosmetic[] = COSMETICS.filter((item) => Boolean(item.rarity));

export interface Opened {
  cosmetic: Cosmetic;
  /** What is left afterwards, so the client need not ask again. */
  keys: number;
  /** How many of the pool are still unseen, for "12 of 16 collected". */
  remaining: number;
  collected: number;
  total: number;
}

/**
 * Picks a tier by weight, then an item within it.
 *
 * Tiers the person has completed are skipped and their weight redistributed,
 * which is what stops a collection nearing completion from rolling a 60%
 * common that cannot be given and having to try again. It also means the last
 * few items arrive faster rather than slower, which is the right way round -
 * the end of a collection should not be the part that stalls.
 */
function roll(available: Cosmetic[]): Cosmetic {
  const byTier = new Map<Rarity, Cosmetic[]>();
  for (const item of available) {
    const tier = item.rarity;
    if (!tier) continue;
    const list = byTier.get(tier) ?? [];
    list.push(item);
    byTier.set(tier, list);
  }

  const live = TIERS.filter((tier) => (byTier.get(tier)?.length ?? 0) > 0);
  const total = live.reduce((sum, tier) => sum + DROP_RATES[tier], 0);

  // Integer arithmetic on a crypto source rather than a float: randomInt gives
  // a uniform integer in a range, where scaling Math.random introduces a bias
  // nobody would ever notice and nobody could ever defend.
  let ticket = randomInt(0, total);
  let chosenTier: Rarity = live[live.length - 1] ?? 'common';
  for (const tier of live) {
    if (ticket < DROP_RATES[tier]) {
      chosenTier = tier;
      break;
    }
    ticket -= DROP_RATES[tier];
  }

  const candidates = byTier.get(chosenTier) ?? [];
  const picked = candidates[randomInt(0, candidates.length)];
  if (!picked) throw errors.invalid('The chest is empty');
  return picked;
}

export async function open(userId: string): Promise<Opened> {
  const owned = await db
    .select({ cosmeticId: ownedCosmetics.cosmeticId })
    .from(ownedCosmetics)
    .where(eq(ownedCosmetics.userId, userId));
  const has = new Set(owned.map((row) => row.cosmeticId));

  const available = CHEST_POOL.filter((item) => !has.has(item.id));
  // Checked before the key is taken. Charging for a chest that cannot contain
  // anything is the one outcome there is no excusing.
  if (available.length === 0) {
    throw errors.invalid('You already have everything the chest can give');
  }

  const cosmetic = roll(available);

  /*
    The reference identifies this opening, not what came out of it.

    The ledger has a unique index on (user, reason, reference) - it is there so
    a repeated webhook cannot grant twice. Keying a spend on the item would
    quietly borrow that guarantee and mean "one chest spend per item per person,
    ever". Nobody would notice today, because the chest never gives out
    something already owned. It would surface the first time ownership was
    reset by anything - a refund, an item dismantled, a collection reworked -
    as a person unable to win that item again: the insert violates the index,
    the transaction rolls back, and they get an error instead of a cosmetic.

    An opening is an event, so it gets its own id. The item stays in the
    reference after it, because a key history that says only "chest" is a key
    history nobody can read.
  */
  const openId = generateId();

  // The key goes first. If the grant fails after this, it comes back - see
  // below - but taking payment after handing over the goods would let a
  // failure here give the item away free.
  await keys.spend({ userId, amount: CHEST_COST, reference: `chest:${openId}:${cosmetic.id}` });

  const claimed = await db
    .insert(ownedCosmetics)
    .values({ userId, cosmeticId: cosmetic.id })
    .onConflictDoNothing()
    .returning({ cosmeticId: ownedCosmetics.cosmeticId });

  if (claimed.length === 0) {
    /*
      Two chests opened at once, both rolling the same item.

      The read above cannot see a write that has not happened yet, so the only
      honest place to find out is the insert. The key goes back and the person
      is asked to try again, which is a worse experience than retrying for them
      - and a much better one than silently taking a key for nothing.
    */
    await keys.record({
      userId,
      amount: CHEST_COST,
      reason: 'refund',
      reference: `chest-refund:${openId}`,
    });
    throw errors.invalid('That one arrived twice at once. Try again.');
  }

  return {
    cosmetic,
    keys: await keys.balanceOf(userId),
    remaining: available.length - 1,
    // Counted against the pool, not against everything owned: the subscription
    // plates are not in the chest, and including them would report a collection
    // as further along than it is.
    collected: CHEST_POOL.filter((item) => has.has(item.id)).length + 1,
    total: CHEST_POOL.length,
  };
}

/** What the app shows before anyone spends anything. */
export async function status(userId: string): Promise<{
  cost: number;
  rates: Record<Rarity, number>;
  collected: number;
  total: number;
}> {
  const owned = await db
    .select({ cosmeticId: ownedCosmetics.cosmeticId })
    .from(ownedCosmetics)
    .where(eq(ownedCosmetics.userId, userId));
  const has = new Set(owned.map((row) => row.cosmeticId));

  return {
    cost: CHEST_COST,
    rates: DROP_RATES,
    collected: CHEST_POOL.filter((item) => has.has(item.id)).length,
    total: CHEST_POOL.length,
  };
}
