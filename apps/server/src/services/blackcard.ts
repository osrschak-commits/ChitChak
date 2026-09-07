import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { staffActions, subscriptions, users } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';
import * as keys from './keys.js';
import { standingOf, type Standing } from './subscriptions.js';

/**
 * A brass black card: a year of Brass, given rather than sold.
 *
 * For the people who helped, the people who were here first, and the occasional
 * apology. It is deliberately a *subscription*, not a separate kind of account -
 * everything downstream already knows what a subscription means, and inventing a
 * second sort of entitlement would mean every check having to ask twice.
 *
 * Provider is recorded as 'blackcard' rather than 'paddle', so a year that
 * nobody paid for is never mistaken for revenue, and a Paddle webhook arriving
 * later for the same person overwrites it in the ordinary way.
 */

/** A year, as a subscription period. */
const CARD_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * What a year is worth in keys.
 *
 * A paying subscriber gets two a month as each period is billed. There is no
 * billing here and no scheduler to imitate it, so the year's worth arrives at
 * once. That is more generous than a monthly drip and simpler than pretending
 * to bill somebody nothing twelve times.
 */
const CARD_KEYS = 24;

export async function issueBlackCard(input: {
  actorId: string;
  username: string;
}): Promise<{ username: string; standing: Standing; cardId: string }> {
  const target = await db.query.users.findFirst({
    where: eq(users.username, input.username.trim().toLowerCase()),
  });
  if (!target) throw errors.notFound(`Nobody here is called "${input.username}"`);
  if (target.deletedAt) throw errors.invalid('That account has been deleted');

  const cardId = generateId();

  /**
   * Written before the card is issued, not after.
   *
   * If something below fails halfway there is still a record that it was
   * attempted, which is the whole point of an audit trail - the actions worth
   * recording are exactly the ones that might go wrong.
   */
  await db.insert(staffActions).values({
    id: generateId(),
    actorId: input.actorId,
    action: 'black_card',
    subjectId: target.id,
    detail: `card ${cardId}, one year, ${CARD_KEYS} keys`,
  });

  const existing = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, target.id),
  });

  // Extends rather than replaces. Giving a card to somebody who already has
  // time left should add to it, not quietly take the remainder away.
  const from = Math.max(Date.now(), existing?.currentPeriodEnd?.getTime() ?? 0);
  const periodEnd = new Date(from + CARD_DURATION_MS);

  await db
    .insert(subscriptions)
    .values({
      userId: target.id,
      status: 'active',
      provider: 'blackcard',
      providerId: cardId,
      currentPeriodEnd: periodEnd,
    })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: {
        status: 'active',
        provider: 'blackcard',
        providerId: cardId,
        currentPeriodEnd: periodEnd,
        updatedAt: new Date(),
      },
    });

  // The card id is the reference, so re-issuing gives another year and another
  // twenty-four, while a retried request gives neither twice.
  await keys.record({
    userId: target.id,
    amount: CARD_KEYS,
    reason: 'grant',
    reference: `blackcard:${cardId}`,
  });

  return { username: target.username, standing: await standingOf(target.id), cardId };
}

/** Every card ever handed out, newest first. */
export async function issuedCards(limit = 50): Promise<
  Array<{ at: string; actor: string; subject: string | null; detail: string | null }>
> {
  const rows = await db
    .select({
      createdAt: staffActions.createdAt,
      actorId: staffActions.actorId,
      subjectId: staffActions.subjectId,
      detail: staffActions.detail,
    })
    .from(staffActions)
    .where(eq(staffActions.action, 'black_card'))
    .orderBy(staffActions.createdAt)
    .limit(limit);

  const names = new Map(
    (await db.select({ id: users.id, username: users.username }).from(users)).map((row) => [
      row.id,
      row.username,
    ]),
  );

  return rows
    .map((row) => ({
      at: row.createdAt.toISOString(),
      actor: names.get(row.actorId) ?? row.actorId,
      subject: row.subjectId ? (names.get(row.subjectId) ?? row.subjectId) : null,
      detail: row.detail,
    }))
    .reverse();
}
