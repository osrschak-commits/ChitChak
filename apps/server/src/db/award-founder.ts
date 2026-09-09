import { asc } from 'drizzle-orm';
import { AWARDED_AT_SIGNUP, award } from '../services/cosmetics.js';
import { closeDatabase, db } from './client.js';
import { users } from './schema.js';

/**
 * Gives the Founder badge to everyone who was already here.
 *
 * Registration hands it out while PRE_LAUNCH is on, but that only covers
 * accounts made after the flag existed. Everybody who signed up before it
 * shipped is exactly the population the badge is meant for, so they are
 * credited here rather than being the only people who never get one.
 *
 *   node apps/server/dist/db/award-founder.js            # report only
 *   node apps/server/dist/db/award-founder.js --apply    # write it
 *   node apps/server/dist/db/award-founder.js --apply chakras   # one person
 *
 * Idempotent: `award` conflicts on the ownership row's primary key and reports
 * that it granted nothing, so a second run says "already had it" and writes
 * nothing. Safe to run again after any registration that logged a failure.
 *
 * Nobody is given the badge equipped. What somebody wears is their choice, and
 * silently changing it for every account on the server is not a backfill.
 *
 * Year one is not here on purpose. It is derived from how old the account is
 * rather than owned, so there is nothing to write - it appears by itself on the
 * day it becomes true.
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.find((arg) => !arg.startsWith('--'));

const everyone = await db
  .select({ id: users.id, username: users.username, createdAt: users.createdAt })
  .from(users)
  .orderBy(asc(users.createdAt));
const chosen = only ? everyone.filter((user) => user.username === only) : everyone;

if (only && chosen.length === 0) {
  console.error(`No user called "${only}".`);
  await closeDatabase();
  process.exit(1);
}

console.log(
  apply
    ? `\nAwarding ${AWARDED_AT_SIGNUP.join(', ')} to ${chosen.length} account${chosen.length === 1 ? '' : 's'}.\n`
    : `\nDry run over ${chosen.length} account${chosen.length === 1 ? '' : 's'}. Add --apply to write.\n`,
);

let granted = 0;
let already = 0;

for (const user of chosen) {
  for (const cosmeticId of AWARDED_AT_SIGNUP) {
    /*
      On a dry run nothing is written, so nothing can be counted as "already
      had it" - which would make the first run's report claim it had done the
      work. It reports what it would do instead, and the real numbers come from
      the run that writes.
    */
    if (!apply) {
      granted += 1;
      continue;
    }

    if (await award(user.id, cosmeticId)) {
      granted += 1;
      console.log(`  ${user.username.padEnd(20)} ${cosmeticId}  (joined ${user.createdAt.toISOString().slice(0, 10)})`);
    } else {
      already += 1;
    }
  }
}

console.log(
  apply
    ? `\n${granted} awarded, ${already} already had it.\n`
    : `\n${granted} would be awarded. Nothing was written.\n`,
);

await closeDatabase();
