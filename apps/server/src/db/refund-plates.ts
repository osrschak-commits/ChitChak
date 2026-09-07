import { eq } from 'drizzle-orm';
import { COSMETICS_BY_ID } from '../services/cosmetics.js';
import * as keys from '../services/keys.js';
import { closeDatabase, db } from './client.js';
import { keyLedger, users } from './schema.js';

/**
 * Gives back keys spent on things that are now included with a subscription.
 *
 * Plates were bought with keys before they became a subscriber perk. Quietly
 * making somebody's purchase free for everyone else is a way to teach people
 * that buying early is a mistake, so the keys go back.
 *
 * A refund entry rather than deleting the spend: the ledger is a record of what
 * happened, and what happened is that they paid and were then refunded. Deleting
 * it would make the balance right and the history a lie.
 *
 *   node apps/server/dist/db/refund-plates.js            # report only
 *   node apps/server/dist/db/refund-plates.js --apply
 *
 * Idempotent. The refund is written with the cosmetic id as its reference, and
 * the ledger's unique index on (user, reason, reference) means a second run
 * pays nothing.
 */

const apply = process.argv.includes('--apply');

const spends = await db
  .select({ userId: keyLedger.userId, amount: keyLedger.amount, reference: keyLedger.reference })
  .from(keyLedger)
  .where(eq(keyLedger.reason, 'spend'));

/** Only the ones whose item is now included rather than bought. */
const owed = spends.filter((row) => {
  const item = row.reference ? COSMETICS_BY_ID.get(row.reference) : undefined;
  return Boolean(item?.requiresSubscription);
});

if (owed.length === 0) {
  console.log('\nNothing to refund.\n');
  await closeDatabase();
  process.exit(0);
}

console.log(apply ? '\nRefunding.\n' : '\nDry run. Add --apply to write.\n');

const names = new Map(
  (await db.select({ id: users.id, username: users.username }).from(users)).map((row) => [
    row.id,
    row.username,
  ]),
);

let total = 0;
for (const row of owed) {
  const amount = -row.amount; // spends are negative
  const who = names.get(row.userId) ?? row.userId;

  let paid = true;
  if (apply) {
    paid = await keys.record({
      userId: row.userId,
      amount,
      reason: 'refund',
      reference: row.reference,
    });
  }

  console.log(
    `  ${who.padEnd(16)} +${String(amount).padStart(3)}  ${row.reference}${paid ? '' : '  (already refunded)'}`,
  );
  if (paid) total += amount;
}

console.log(`\n${apply ? 'Refunded' : 'Would refund'} ${total} keys across ${owed.length} purchases.`);

// What they are left with, so the numbers can be checked against the app.
const affected = [...new Set(owed.map((row) => row.userId))];
for (const userId of affected) {
  console.log(`  ${(names.get(userId) ?? userId).padEnd(16)} balance now ${await keys.balanceOf(userId)}`);
}
console.log('');

await closeDatabase();
