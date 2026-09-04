import { eq } from 'drizzle-orm';
import { generateId } from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import { closeDatabase, db } from './client.js';
import { channels, guildMembers, guilds, users } from './schema.js';

/**
 * Development seed: two accounts in one server, so voice can actually be tested
 * (a call needs two people). Idempotent - safe to re-run.
 */

const PASSWORD = 'devpassword123';

const accounts = [
  { username: 'alice', displayName: 'Alice', email: 'alice@example.com' },
  { username: 'bob', displayName: 'Bob', email: 'bob@example.com' },
];

const passwordHash = await hashPassword(PASSWORD);
const created: string[] = [];

for (const account of accounts) {
  const existing = await db.query.users.findFirst({ where: eq(users.email, account.email) });
  if (existing) {
    created.push(existing.id);
    continue;
  }
  const [user] = await db
    .insert(users)
    .values({ id: generateId(), ...account, passwordHash })
    .returning();
  if (user) created.push(user.id);
}

const [ownerId, secondId] = created;
if (!ownerId) throw new Error('Seed failed: no owner account');

let guild = await db.query.guilds.findFirst({ where: eq(guilds.name, 'Test Server') });

if (!guild) {
  const guildId = generateId();
  [guild] = await db
    .insert(guilds)
    .values({ id: guildId, name: 'Test Server', ownerId })
    .returning();

  await db.insert(channels).values([
    { id: generateId(), guildId, name: 'general', kind: 'text', position: 0 },
    { id: generateId(), guildId, name: 'General', kind: 'voice', position: 1 },
    { id: generateId(), guildId, name: 'Gaming', kind: 'voice', position: 2, userLimit: 10 },
  ]);
}

if (!guild) throw new Error('Seed failed: no guild');

for (const userId of [ownerId, secondId].filter(Boolean) as string[]) {
  await db
    .insert(guildMembers)
    .values({ guildId: guild.id, userId })
    .onConflictDoNothing();
}

console.log('Seeded:');
for (const account of accounts) {
  console.log(`  ${account.email}  /  ${PASSWORD}`);
}
console.log(`  server "${guild.name}" with #general, and voice channels General + Gaming`);

await closeDatabase();
