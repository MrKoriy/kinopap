CREATE TABLE "favorites" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_profile_item_uq" ON "favorites" USING btree ("profile_id","item_id");--> statement-breakpoint
CREATE INDEX "favorites_profile_created_idx" ON "favorites" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "favorites_item_idx" ON "favorites" USING btree ("item_id");