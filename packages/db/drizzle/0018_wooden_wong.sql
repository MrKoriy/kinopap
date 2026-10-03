CREATE TABLE IF NOT EXISTS "item_redirects" (
	"from_id" integer PRIMARY KEY NOT NULL,
	"to_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_redirects" ADD CONSTRAINT "item_redirects_to_id_items_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
