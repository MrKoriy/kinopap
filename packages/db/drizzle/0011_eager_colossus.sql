CREATE TYPE "public"."ingest_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
DROP INDEX "items_type_idx";--> statement-breakpoint
ALTER TABLE "ingest_jobs" ALTER COLUMN "status" SET DEFAULT 'queued'::"public"."ingest_job_status";--> statement-breakpoint
ALTER TABLE "ingest_jobs" ALTER COLUMN "status" SET DATA TYPE "public"."ingest_job_status" USING "status"::"public"."ingest_job_status";