-- Full-text search over message content, one channel at a time.
--
-- An expression index rather than a stored tsvector column: the vector is
-- derived from `content` and nothing else, so storing it would be a second copy
-- of the same fact that a bad UPDATE could put out of step with the first.
--
-- The query has to spell the expression exactly as it appears here or Postgres
-- will not use the index and will read every message in the channel instead.
CREATE INDEX IF NOT EXISTS "messages_search_idx"
  ON "messages" USING gin (to_tsvector('english', "content"));
--> statement-breakpoint
-- Filtering a search to one person.
CREATE INDEX IF NOT EXISTS "messages_channel_author_idx"
  ON "messages" ("channel_id", "author_id");
