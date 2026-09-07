CREATE TABLE "key_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owned_cosmetics" (
	"user_id" text NOT NULL,
	"cosmetic_id" text NOT NULL,
	"equipped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owned_cosmetics_user_id_cosmetic_id_pk" PRIMARY KEY("user_id","cosmetic_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"provider" text,
	"provider_id" text,
	"current_period_end" timestamp with time zone,
	"last_granted_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "key_ledger" ADD CONSTRAINT "key_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_cosmetics" ADD CONSTRAINT "owned_cosmetics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "key_ledger_user_idx" ON "key_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "key_ledger_reference_idx" ON "key_ledger" USING btree ("user_id","reason","reference");--> statement-breakpoint
CREATE INDEX "owned_cosmetics_user_idx" ON "owned_cosmetics" USING btree ("user_id");