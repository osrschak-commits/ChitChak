import { DEFAULT_RANK_PERMISSIONS } from '@chitchak/protocol';
import { and, eq } from 'drizzle-orm';
import { generateId } from '../lib/ids.js';
import { closeDatabase, db } from './client.js';
import { guilds, ranks } from './schema.js';

/**
 * Gives every guild a default rank.
 *
 * Guilds created before ranks existed have none, and permissions resolve from
 * the default rank - so without this every non-owner in an older guild would
 * come out with no permissions at all and lose access to their own server.
 *
 * Idempotent: re-running it is a no-op. Guilds created from now on get their
 * default rank in the same transaction as the guild itself.
 */
const allGuilds = await db.select().from(guilds);
let created = 0;

for (const guild of allGuilds) {
  const existing = await db.query.ranks.findFirst({
    where: and(eq(ranks.guildId, guild.id), eq(ranks.isDefault, true)),
  });
  if (existing) continue;

  await db.insert(ranks).values({
    id: generateId(),
    guildId: guild.id,
    name: 'Member',
    color: null,
    position: 0,
    permissions: DEFAULT_RANK_PERMISSIONS,
    isDefault: true,
  });
  created += 1;
  console.log(`  default rank created for "${guild.name}"`);
}

console.log(
  created === 0
    ? `All ${allGuilds.length} servers already have a default rank.`
    : `Backfilled ${created} of ${allGuilds.length} servers.`,
);

await closeDatabase();
