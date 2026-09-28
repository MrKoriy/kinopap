ALTER TYPE "public"."item_type" ADD VALUE 'anime' BEFORE 'concert';--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "external_source" varchar(32);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "external_id" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "items_external_uq" ON "items" USING btree ("external_source","external_id");