import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { closeDatabase, db } from './client.js';

/** Applies every pending migration in apps/server/drizzle, then exits. */
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

await migrate(db, { migrationsFolder });
console.log(`Migrations applied from ${migrationsFolder}`);
await closeDatabase();
