CREATE TYPE "public"."image_kind" AS ENUM('user_avatar', 'guild_icon');--> statement-breakpoint
CREATE TABLE "images" (
	"kind" "image_kind" NOT NULL,
	"owner_id" text NOT NULL,
	"mime_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "images_kind_owner_id_pk" PRIMARY KEY("kind","owner_id")
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "icon_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accent_color" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_states" ADD COLUMN "self_video" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_states" ADD COLUMN "self_screen_share" boolean DEFAULT false NOT NULL;