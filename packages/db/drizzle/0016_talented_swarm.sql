DROP INDEX "items_tmdb_type_id_uq";--> statement-breakpoint
CREATE INDEX "watch_progress_profile_status_idx" ON "watch_progress" USING btree ("profile_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "items_tmdb_type_id_uq" ON "items" USING btree ("tmdb_type","tmdb_id") WHERE (tmdb_type IS NOT NULL) AND (tmdb_id IS NOT NULL);