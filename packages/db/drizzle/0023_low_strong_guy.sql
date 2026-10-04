CREATE TABLE "rum_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(16) NOT NULL,
	"value" double precision NOT NULL,
	"page" varchar(120),
	"item_id" integer,
	"rating" varchar(24),
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"cursor" text,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"stats" jsonb,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tmdb_refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tmdb_changed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "rum_events_name_created_idx" ON "rum_events" USING btree ("name","created_at");