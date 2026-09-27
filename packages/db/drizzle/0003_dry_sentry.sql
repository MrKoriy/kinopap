ALTER TABLE "audio_tracks" ADD COLUMN "master_key" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;