import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import * as keys from './keys.js';

/**
 * Who is subscribed, and the keys that come with it.
 *
 * The payment provider is deliberately not imported here. Whichever one is
 * eventually chosen, its job is to tell this module two things - that somebody
 * is paid up, and until when - and everything downstream is the same either
 * way. `applyFromProvider` is the whole seam.
 *
 * The tier has a name for the same reason the app does: "subscribed" is a
 * billing state, not a thing anyone would say. See PREMIUM.md.
 */

export type Status = 'none' | 'active' | 'past_due' | 'cancelled';

export interface Standing {
  status: Status;
  /** True only for a subscription that is paid up right now. */
  active: boolean;
  /** When the current period ends, if there is one. */
  renewsAt: string | null;
  keys: number;
}

function isActive(status: string, periodEnd: Date | null): boolean {
  if (status !== 'active') return false;
  // A period that has run out is not active however the row is labelled: the
  // provider's cancellation webhook can be late, lost, or never sent, and the
  // failure should be the subscription lapsing rather than lasting forever.
  return periodEnd === null || periodEnd.getTime() > Date.now();
}

export async function standingOf(userId: string): Promise<Standing> {
  const row = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  });

  const balance = await keys.balanceOf(userId);
  if (!row) return { status: 'none', active: false, renewsAt: null, keys: balance };

  return {
    status: row.status as Status,
    active: isActive(row.status, row.currentPeriodEnd),
    renewsAt: row.currentPeriodEnd?.toISOString() ?? null,
    keys: balance,
  };
}

/**
 * The one door a payment provider comes through.
 *
 * Whatever the provider is, its webhook resolves to this: this person is in
 * this state until this date. Nothing above this line knows about Stripe or
 * Paddle, and nothing below it needs to.
 *
 * Granting the period's keys happens here rather than on a schedule, because a
 * webhook arriving is the only reliable moment we learn a period has rolled
 * over. The ledger's reference is the period end, which makes redelivery
 * harmless: the same period can be granted a hundred times and pays out once.
 */
export async function applyFromProvider(input: {
  userId: string;
  status: Status;
  periodEnd: Date | null;
  provider: string;
  providerId: string | null;
}): Promise<Standing> {
  await db
    .insert(subscriptions)
    .values({
      userId: input.userId,
      status: input.status,
      provider: input.provider,
      providerId: input.providerId,
      currentPeriodEnd: input.periodEnd,
    })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: {
        status: input.status,
        provider: input.provider,
        providerId: input.providerId,
        currentPeriodEnd: input.periodEnd,
        updatedAt: new Date(),
      },
    });

  if (isActive(input.status, input.periodEnd) && input.periodEnd) {
    const granted = await keys.record({
      userId: input.userId,
      amount: keys.KEYS_PER_PERIOD,
      reason: 'subscription',
      reference: input.periodEnd.toISOString(),
    });
    if (granted) {
      await db
        .update(subscriptions)
        .set({ lastGrantedPeriodEnd: input.periodEnd })
        .where(eq(subscriptions.userId, input.userId));
    }
  }

  return standingOf(input.userId);
}
