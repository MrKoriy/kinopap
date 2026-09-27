DROP INDEX "item_genres_genre_idx";--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_key" varchar(64);--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "items_title_idx" ON "items" USING btree ("title");--> statement-breakpoint
CREATE INDEX "items_type_year_idx" ON "items" USING btree ("type","year");--> statement-breakpoint
CREATE INDEX "items_type_views_idx" ON "items" USING btree ("type","views");--> statement-breakpoint
CREATE INDEX "items_type_rating_idx" ON "items" USING btree ("type","rating");--> statement-breakpoint
CREATE INDEX "media_item_part_idx" ON "media" USING btree ("item_id","part_number");--> statement-breakpoint
CREATE UNIQUE INDEX "media_item_source_uq" ON "media" USING btree ("item_id","source_key");--> statement-breakpoint
CREATE INDEX "ingest_jobs_status_created_idx" ON "ingest_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "comments_item_parent_idx" ON "comments" USING btree ("item_id","parent_id");