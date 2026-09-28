CREATE TABLE "media_sources" (
	"item_id" integer NOT NULL,
	"media_id" integer NOT NULL,
	"files" jsonb NOT NULL,
	"audios" jsonb NOT NULL,
	"intro" jsonb,
	"warm" jsonb,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_sources_item_id_media_id_pk" PRIMARY KEY("item_id","media_id")
);
--> statement-breakpoint
ALTER TABLE "media_sources" ADD CONSTRAINT "media_sources_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_sources" ADD CONSTRAINT "media_sources_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_sources_resolved_at_idx" ON "media_sources" USING btree ("resolved_at");