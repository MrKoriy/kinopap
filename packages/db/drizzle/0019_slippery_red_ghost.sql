CREATE TABLE IF NOT EXISTS "item_external_aliases" (
	"source" varchar(32) NOT NULL,
	"external_id" varchar(64) NOT NULL,
	"item_id" integer NOT NULL,
	"season_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_external_aliases_source_external_id_pk" PRIMARY KEY("source","external_id")
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "title_localized_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_external_aliases" ADD CONSTRAINT "item_external_aliases_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
