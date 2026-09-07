CREATE TABLE "staff_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"subject_id" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_actions" ADD CONSTRAINT "staff_actions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_actions_actor_idx" ON "staff_actions" USING btree ("actor_id");