CREATE TABLE "franchise_entries" (
	"franchise_id" integer NOT NULL,
	"anilist_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"format" varchar(16),
	"year" integer,
	"episodes" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"item_id" integer,
	CONSTRAINT "franchise_entries_franchise_id_anilist_id_pk" PRIMARY KEY("franchise_id","anilist_id")
);
--> statement-breakpoint
CREATE TABLE "franchises" (
	"id" serial PRIMARY KEY NOT NULL,
	"anilist_root_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchises_anilist_root_id_unique" UNIQUE("anilist_root_id")
);
--> statement-breakpoint
CREATE TABLE "quality_anomalies" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"kind" varchar(32) NOT NULL,
	"details" jsonb,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "season_overrides" (
	"item_id" integer PRIMARY KEY NOT NULL,
	"layout" jsonb NOT NULL,
	"note" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_people" ADD COLUMN "ord" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "backdrop_url" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "credits_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "anilist_id" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "anilist_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "franchise_id" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "poster_hash" varchar(40);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "backdrop_hash" varchar(40);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "poster_blurhash" varchar(64);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "dominant_color" varchar(7);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "images_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "tmdb_id" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "intro_source" varchar(16);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "intro_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "franchise_entries" ADD CONSTRAINT "franchise_entries_franchise_id_franchises_id_fk" FOREIGN KEY ("franchise_id") REFERENCES "public"."franchises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_entries" ADD CONSTRAINT "franchise_entries_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_anomalies" ADD CONSTRAINT "quality_anomalies_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_overrides" ADD CONSTRAINT "season_overrides_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "franchise_entries_item_idx" ON "franchise_entries" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_anomalies_item_kind_uq" ON "quality_anomalies" USING btree ("item_id","kind");--> statement-breakpoint
CREATE INDEX "quality_anomalies_status_idx" ON "quality_anomalies" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "items_franchise_idx" ON "items" USING btree ("franchise_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_tmdb_uq" ON "people" USING btree ("tmdb_id") WHERE tmdb_id IS NOT NULL;