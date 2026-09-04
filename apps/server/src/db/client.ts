import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config, isProduction } from '../config.js';
import * as schema from './schema.js';

/**
 * One connection pool for the process. `max` is deliberately modest: Postgres
 * handles far fewer concurrent connections well than people expect, and the
 * workload here is many short queries rather than few long ones.
 */
export const sql = postgres(config.DATABASE_URL, {
  max: isProduction ? 20 : 5,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: isProduction ? () => {} : undefined,
});

export const db = drizzle(sql, { schema, logger: false });

export type Database = typeof db;

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
}
