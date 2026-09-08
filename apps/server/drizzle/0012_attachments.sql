CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text,
	"uploader_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "attachments_orphan_idx" ON "attachments" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "attachments_sha_idx" ON "attachments" USING btree ("sha256");