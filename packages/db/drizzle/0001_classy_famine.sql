CREATE TABLE "ingest_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_type" varchar(16) NOT NULL,
	"source_ref" text NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"item_id" integer,
	"media_id" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tmdb_id" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tmdb_rating" double precision;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tmdb_votes" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "poster_key" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "sprite_key" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "sprite_meta" jsonb;--> statement-breakpoint
ALTER TABLE "ingest_jobs" ADD CONSTRAINT "ingest_jobs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_jobs" ADD CONSTRAINT "ingest_jobs_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_jobs_status_idx" ON "ingest_jobs" USING btree ("status");