-- tmdbType: разделяем пространства movie/tv (TMDb id пересекаются).
ALTER TABLE "items" ADD COLUMN "tmdb_type" varchar(8);--> statement-breakpoint
UPDATE "items" SET "tmdb_type" = CASE WHEN "type" = 'movie' THEN 'movie' ELSE 'tv' END WHERE "tmdb_id" IS NOT NULL;--> statement-breakpoint
-- Дедуп серий-дублей с одним tmdb_id (вариации названия одного сериала): оставляем более полный, у второго зануляем tmdb_id.
WITH dupes AS (
  SELECT tmdb_id, tmdb_type, array_agg(id ORDER BY views DESC, id) AS ids
  FROM items WHERE tmdb_type IS NOT NULL AND tmdb_id IS NOT NULL
  GROUP BY tmdb_id, tmdb_type HAVING count(*) > 1
)
UPDATE items SET tmdb_id = NULL, tmdb_type = NULL
WHERE id IN (SELECT unnest(ids[2:]) FROM dupes);--> statement-breakpoint
CREATE INDEX "items_tmdb_type_idx" ON "items" USING btree ("tmdb_type");--> statement-breakpoint
CREATE UNIQUE INDEX "items_tmdb_type_id_uq" ON "items" USING btree ("tmdb_type","tmdb_id") WHERE "tmdb_type" IS NOT NULL AND "tmdb_id" IS NOT NULL;
