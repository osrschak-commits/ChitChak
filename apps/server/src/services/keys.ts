import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { keyLedger } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { generateId } from '../lib/ids.js';

/**
 * Chak keys: the ledger, and everything that moves them.
 *
 * There is no balance column anywhere. A balance is a sum of the ledger, which
 * costs an index scan and buys something a column cannot: when somebody asks
 * where their keys went - and that is the question people actually ask, usually
 * because they think something has gone wrong - there is an answer. A column
 * would only be able to say how many are left.
 *
 * Nothing here writes a bare row. Everything goes through `record`, which makes
 * every movement idempotent by construction: the ledger's unique index is on
 * (user, reason, reference), so a payment webhook delivered three times pays out
 * once and the second and third attempts are silently the same as the first.
 */

export type KeyReason = 'subscription' | 'purchase' | 'spend' | 'grant' | 'refund';

/** What a subscription is worth each period. */
export const KEYS_PER_PERIOD = 2;

export async function balanceOf(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${keyLedger.amount}), 0)` })
    .from(keyLedger)
    .where(eq(keyLedger.userId, userId));
  return Number(row?.total ?? 0);
}

/**
 * Move keys, once.
 *
 * @param reference What this movement is about, and the thing that makes it
 *   happen only once: a provider payment id, the period a grant was for, the
 *   cosmetic being bought. Pass null only where repeating genuinely is intended.
 * @returns whether this call is the one that moved them.
 */
export async function record(input: {
  userId: string;
  amount: number;
  reason: KeyReason;
  reference: string | null;
}): Promise<boolean> {
  if (input.amount === 0) return false;

  const written = await db
    .insert(keyLedger)
    .values({
      id: generateId(),
      userId: input.userId,
      amount: input.amount,
      reason: input.reason,
      reference: input.reference,
    })
    .onConflictDoNothing()
    .returning({ id: keyLedger.id });

  return written.length > 0;
}

/**
 * Spend keys, refusing to go negative.
 *
 * The balance is read and the entry written inside one transaction, at an
 * isolation level that makes two concurrent spends conflict rather than both
 * pass. Reading the balance and then writing outside a transaction is the
 * classic way to let somebody buy two things with the keys for one, by clicking
 * twice quickly enough - and here the two requests are the same person, so it
 * is not a rare race but the obvious way to try it on.
 */
export async function spend(input: {
  userId: string;
  amount: number;
  reference: string;
}): Promise<void> {
  if (input.amount <= 0) throw errors.invalid('That costs nothing');

  // One retry, because a serialization failure here is not an error - it is two
  // of this person's own clicks arriving together. The retry reads the balance
  // the winner committed and then either succeeds or refuses with a real
  // reason, which is what should have happened the first time. Without it the
  // loser gets "Something went wrong", which reads as a broken app rather than
  // as "you cannot afford that".
  for (let attempt = 0; ; attempt += 1) {
    try {
      await spendOnce(input);
      return;
    } catch (error) {
      if (attempt === 0 && isSerializationFailure(error)) continue;
      throw error;
    }
  }
}

/** Postgres raises 40001 when a serializable transaction cannot be ordered. */
function isSerializationFailure(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '40001';
}

async function spendOnce(input: {
  userId: string;
  amount: number;
  reference: string;
}): Promise<void> {
  await db.transaction(
    async (tx) => {
      const [row] = await tx
        .select({ total: sql<string>`coalesce(sum(${keyLedger.amount}), 0)` })
        .from(keyLedger)
        .where(eq(keyLedger.userId, input.userId));

      const balance = Number(row?.total ?? 0);
      if (balance < input.amount) {
        throw errors.invalid(
          `That costs ${input.amount} ${input.amount === 1 ? 'key' : 'keys'} and you have ${balance}`,
        );
      }

      await tx.insert(keyLedger).values({
        id: generateId(),
        userId: input.userId,
        amount: -input.amount,
        reason: 'spend',
        reference: input.reference,
      });
    },
    // Serializable, because the check and the write have to be one decision.
    // Repeatable read would still let two transactions each read the same
    // balance and each write - the rows they insert do not conflict with one
    // another, which is exactly the problem.
    { isolationLevel: 'serializable' },
  );
}

/** What somebody's keys have done, newest first. */
export async function history(
  userId: string,
  limit = 50,
): Promise<Array<{ amount: number; reason: string; reference: string | null; at: string }>> {
  const rows = await db
    .select()
    .from(keyLedger)
    .where(eq(keyLedger.userId, userId))
    .orderBy(sql`${keyLedger.createdAt} desc`)
    .limit(Math.min(Math.max(limit, 1), 200));

  return rows.map((row) => ({
    amount: row.amount,
    reason: row.reason,
    reference: row.reference,
    at: row.createdAt.toISOString(),
  }));
}
