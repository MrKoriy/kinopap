CREATE INDEX "items_tmdb_id_idx" ON "items" USING btree ("tmdb_id");--> statement-breakpoint
CREATE INDEX "items_title_year_idx" ON "items" USING btree ("title","year");