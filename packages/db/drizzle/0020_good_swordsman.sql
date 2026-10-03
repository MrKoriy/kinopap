ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "no_source_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "no_source_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "tmdb_matched_at" timestamp with time zone;
