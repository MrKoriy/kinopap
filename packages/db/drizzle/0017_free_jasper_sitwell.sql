ALTER TABLE "episodes" ADD COLUMN IF NOT EXISTS "orig_season" integer;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN IF NOT EXISTS "orig_number" integer;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN IF NOT EXISTS "absolute_number" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "season_layout" varchar(64);