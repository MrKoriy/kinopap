-- media_files.quality: varchar(16) → enum media_quality (лестница ингеста 480p/720p/1080p/2160p,
-- значения из QUALITIES в @zal/api-client). Кастинг USING падает громко на
-- неизвестных значениях — честная защита прод-данных, без UPDATE-подчисток.
CREATE TYPE "public"."media_quality" AS ENUM('480p', '720p', '1080p', '2160p');--> statement-breakpoint
ALTER TABLE "media_files" ALTER COLUMN "quality" SET DATA TYPE "public"."media_quality" USING "quality"::"public"."media_quality";
