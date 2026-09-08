import type { Emoji } from '@chitchak/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { guildEmoji, type GuildEmojiRow } from '../db/schema.js';
import { errors } from '../lib/errors.js';
import { removeStored } from '../lib/storage.js';
import { attachments } from '../db/schema.js';
import { standingOf } from './subscriptions.js';

/**
 * Custom emoji, per server.
 *
 * Adding one is the subscriber part. Using one is not: a server's emoji belong
 * to the server, and an emoji half the room cannot see is worse than no emoji -
 * it turns a shared joke into a message that reads differently depending on who
 * is paying. So the subscription is checked when a picture is added and never
 * when one is drawn.
 */

/** How many a single server may hold. */
export const MAX_PER_GUILD = 50;

/**
 * Small, because an emoji is drawn at about twenty pixels.
 *
 * Well under the free upload cap on purpose: the limit that matters here is not
 * disk, it is that these are fetched by everyone in the server on every message
 * that uses them. A 5MB "emoji" would be a 5MB download in a channel where it
 * appears once.
 */
export const MAX_BYTES = 256 * 1024;

/** What may go between the colons. */
const NAME = /^[a-z0-9_]{2,32}$/;

export function normaliseName(raw: unknown): string {
  if (typeof raw !== 'string') throw errors.invalid('An emoji needs a name');
  const name = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!NAME.test(name)) {
    throw errors.invalid(
      'Emoji names are 2 to 32 characters, using letters, numbers and underscores',
    );
  }
  return name;
}

/**
 * The picture kinds worth allowing.
 *
 * A short allowlist rather than "any image": these are served unsigned and
 * inline to everybody in the server, so the same reasoning applies as to
 * attachments, only harder. SVG is absent because it can carry script.
 */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function assertUsableImage(mimeType: string): void {
  if (!ALLOWED.has(mimeType)) {
    throw errors.invalid('An emoji has to be a PNG, JPEG, GIF or WebP');
  }
}

export async function requireSubscriber(userId: string): Promise<void> {
  if (!(await standingOf(userId)).active) {
    throw errors.forbidden('Adding custom emoji is part of Brass');
  }
}

/**
 * Unsigned and stable, like an avatar rather than like an attachment.
 *
 * These are decoration shown to everyone who can see the server, and they are
 * fetched again on every message that uses them. A signed link that expired
 * daily would mean every emoji in a long channel reloading itself, and a
 * message from last year rendering as a broken image.
 */
export function toEmoji(row: GuildEmojiRow): Emoji {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    url: `/api/emoji/${row.id}`,
    creatorId: row.creatorId,
  };
}

export async function forGuilds(guildIds: string[]): Promise<Emoji[]> {
  if (guildIds.length === 0) return [];
  const rows = await db.select().from(guildEmoji).where(inArray(guildEmoji.guildId, guildIds));
  return rows.map(toEmoji);
}

export async function forGuild(guildId: string): Promise<Emoji[]> {
  const rows = await db.select().from(guildEmoji).where(eq(guildEmoji.guildId, guildId));
  return rows.map(toEmoji);
}

export async function countIn(guildId: string): Promise<number> {
  const rows = await db
    .select({ id: guildEmoji.id })
    .from(guildEmoji)
    .where(eq(guildEmoji.guildId, guildId));
  return rows.length;
}

/**
 * Removes one, and the file behind it if nothing else needs those bytes.
 *
 * Storage is content addressed and shared with attachments, so the same picture
 * uploaded as an emoji and sent as a file is one file. Deleting either must not
 * take it from the other.
 */
export async function remove(guildId: string, emojiId: string): Promise<GuildEmojiRow> {
  const [row] = await db
    .delete(guildEmoji)
    .where(and(eq(guildEmoji.guildId, guildId), eq(guildEmoji.id, emojiId)))
    .returning();
  if (!row) throw errors.notFound('No such emoji');

  const [otherEmoji] = await db
    .select({ id: guildEmoji.id })
    .from(guildEmoji)
    .where(eq(guildEmoji.sha256, row.sha256))
    .limit(1);
  const [asAttachment] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.sha256, row.sha256))
    .limit(1);

  if (!otherEmoji && !asAttachment) await removeStored(row.sha256);
  return row;
}
