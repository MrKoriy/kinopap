CREATE TYPE "public"."stream_source_status" AS ENUM('good', 'bad', 'dead');--> statement-breakpoint
CREATE TABLE "stream_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"media_id" integer NOT NULL,
	"episode_id" integer,
	"infohash" varchar(40) NOT NULL,
	"magnet" text NOT NULL,
	"title" text NOT NULL,
	"file_index" integer,
	"quality" varchar(32),
	"size_bytes" bigint,
	"voices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seeds" integer DEFAULT 0 NOT NULL,
	"peers" integer DEFAULT 0 NOT NULL,
	"status" "stream_source_status" DEFAULT 'good' NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "playable" boolean;--> statement-breakpoint
ALTER TABLE "stream_sources" ADD CONSTRAINT "stream_sources_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_sources" ADD CONSTRAINT "stream_sources_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_sources" ADD CONSTRAINT "stream_sources_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stream_sources_media_hash_uq" ON "stream_sources" USING btree ("media_id","infohash");--> statement-breakpoint
CREATE INDEX "stream_sources_item_status_idx" ON "stream_sources" USING btree ("item_id","status");--> statement-breakpoint
CREATE INDEX "stream_sources_checked_at_idx" ON "stream_sources" USING btree ("checked_at");