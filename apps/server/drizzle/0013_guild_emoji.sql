CREATE TABLE "guild_emoji" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"creator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_emoji" ADD CONSTRAINT "guild_emoji_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_emoji" ADD CONSTRAINT "guild_emoji_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guild_emoji_name_idx" ON "guild_emoji" USING btree ("guild_id","name");--> statement-breakpoint
CREATE INDEX "guild_emoji_guild_idx" ON "guild_emoji" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "guild_emoji_sha_idx" ON "guild_emoji" USING btree ("sha256");