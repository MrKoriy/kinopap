CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."audio_dub_type" AS ENUM('mvo', 'uvo', 'dvo', 'avo', 'original');--> statement-breakpoint
CREATE TYPE "public"."genre_type" AS ENUM('movie', 'music', 'docu', 'tvshow');--> statement-breakpoint
CREATE TYPE "public"."item_type" AS ENUM('movie', 'serial', 'concert', 'documovie', 'docuserial', 'tvshow', '3d', '4k');--> statement-breakpoint
CREATE TYPE "public"."person_role" AS ENUM('actor', 'director', 'writer', 'producer', 'composer', 'voice');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."watch_status" AS ENUM('unwatched', 'in_progress', 'watched');--> statement-breakpoint
CREATE TABLE "invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"created_by" integer NOT NULL,
	"used_by" integer,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"avatar_url" text,
	"is_kids" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "countries" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(120) NOT NULL,
	CONSTRAINT "countries_title_unique" UNIQUE("title")
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(255),
	"plot" text,
	"runtime" integer DEFAULT 0 NOT NULL,
	"thumbnail_url" text,
	"air_date" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "genres" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" "genre_type" NOT NULL,
	"title" varchar(120) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_countries" (
	"item_id" integer NOT NULL,
	"country_id" integer NOT NULL,
	CONSTRAINT "item_countries_item_id_country_id_pk" PRIMARY KEY("item_id","country_id")
);
--> statement-breakpoint
CREATE TABLE "item_genres" (
	"item_id" integer NOT NULL,
	"genre_id" integer NOT NULL,
	CONSTRAINT "item_genres_item_id_genre_id_pk" PRIMARY KEY("item_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "item_people" (
	"item_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"role" "person_role" NOT NULL,
	"character_name" varchar(255),
	CONSTRAINT "item_people_item_id_person_id_role_pk" PRIMARY KEY("item_id","person_id","role")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" "item_type" NOT NULL,
	"subtype" varchar(32),
	"title" varchar(255) NOT NULL,
	"original_title" varchar(255),
	"year" integer,
	"plot" text,
	"runtime_avg" integer,
	"runtime_total" integer,
	"langs" integer DEFAULT 1 NOT NULL,
	"has_ac3" boolean DEFAULT false NOT NULL,
	"quality" integer,
	"imdb_id" integer,
	"imdb_rating" double precision,
	"imdb_votes" integer,
	"kinopoisk_id" integer,
	"kinopoisk_rating" double precision,
	"kinopoisk_votes" integer,
	"rating" double precision DEFAULT 0 NOT NULL,
	"votes_positive" integer DEFAULT 0 NOT NULL,
	"votes_negative" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"finished" boolean,
	"advert" boolean DEFAULT false NOT NULL,
	"poster_small" text,
	"poster_medium" text,
	"poster_big" text,
	"trailer_id" varchar(64),
	"trailer_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"name_en" varchar(255),
	"photo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "audio_tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"media_id" integer NOT NULL,
	"track_index" integer DEFAULT 0 NOT NULL,
	"codec" varchar(16) DEFAULT 'aac' NOT NULL,
	"channels" integer DEFAULT 2 NOT NULL,
	"lang" varchar(8) DEFAULT 'rus' NOT NULL,
	"dub_type" "audio_dub_type" DEFAULT 'mvo' NOT NULL,
	"author_title" varchar(120),
	"author_short_title" varchar(120),
	"file_key" text
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"episode_id" integer,
	"part_number" integer DEFAULT 1 NOT NULL,
	"title" varchar(255),
	"thumbnail_url" text,
	"runtime" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"media_id" integer NOT NULL,
	"quality" varchar(16) NOT NULL,
	"quality_id" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"codec" varchar(16) DEFAULT 'h264' NOT NULL,
	"bitrate" integer,
	"size_bytes" integer,
	"file_key" text NOT NULL,
	"hls_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtitles" (
	"id" serial PRIMARY KEY NOT NULL,
	"media_id" integer NOT NULL,
	"lang" varchar(8) NOT NULL,
	"shift_ms" integer DEFAULT 0 NOT NULL,
	"embed" boolean DEFAULT false NOT NULL,
	"title" varchar(64),
	"file_key" text
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"profile_id" integer NOT NULL,
	"parent_id" integer,
	"depth" integer DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list_items" (
	"list_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "list_items_list_id_item_id_pk" PRIMARY KEY("list_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" integer NOT NULL,
	"title" varchar(160) NOT NULL,
	"description" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"positive" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"media_id" integer NOT NULL,
	"position_seconds" integer DEFAULT 0 NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"status" "watch_status" DEFAULT 'unwatched' NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_countries" ADD CONSTRAINT "item_countries_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_countries" ADD CONSTRAINT "item_countries_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_genres" ADD CONSTRAINT "item_genres_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_genres" ADD CONSTRAINT "item_genres_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_people" ADD CONSTRAINT "item_people_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_people" ADD CONSTRAINT "item_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_tracks" ADD CONSTRAINT "audio_tracks_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitles" ADD CONSTRAINT "subtitles_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_items" ADD CONSTRAINT "list_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_created_by_idx" ON "invites" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_user_name_uq" ON "profiles" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_season_number_uq" ON "episodes" USING btree ("season_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "genres_type_title_uq" ON "genres" USING btree ("type","title");--> statement-breakpoint
CREATE INDEX "item_countries_country_idx" ON "item_countries" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX "item_genres_genre_idx" ON "item_genres" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "item_people_person_idx" ON "item_people" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "item_people_role_idx" ON "item_people" USING btree ("role");--> statement-breakpoint
CREATE INDEX "items_type_idx" ON "items" USING btree ("type");--> statement-breakpoint
CREATE INDEX "items_year_idx" ON "items" USING btree ("year");--> statement-breakpoint
CREATE INDEX "items_rating_idx" ON "items" USING btree ("rating");--> statement-breakpoint
CREATE INDEX "items_views_idx" ON "items" USING btree ("views");--> statement-breakpoint
CREATE INDEX "items_created_idx" ON "items" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "items_updated_idx" ON "items" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "items_title_trgm" ON "items" USING gin (title gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "items_original_title_trgm" ON "items" USING gin (original_title gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "people_name_trgm" ON "people" USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_item_number_uq" ON "seasons" USING btree ("item_id","number");--> statement-breakpoint
CREATE INDEX "audio_tracks_media_idx" ON "audio_tracks" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "media_item_idx" ON "media" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "media_episode_idx" ON "media" USING btree ("episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_media_quality_uq" ON "media_files" USING btree ("media_id","quality");--> statement-breakpoint
CREATE INDEX "subtitles_media_idx" ON "subtitles" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "comments_item_created_idx" ON "comments" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "list_items_item_idx" ON "list_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "lists_profile_idx" ON "lists" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_profile_item_uq" ON "subscriptions" USING btree ("profile_id","item_id");--> statement-breakpoint
CREATE INDEX "subscriptions_item_idx" ON "subscriptions" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_profile_item_uq" ON "votes" USING btree ("profile_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_progress_profile_media_uq" ON "watch_progress" USING btree ("profile_id","media_id");--> statement-breakpoint
CREATE INDEX "watch_progress_profile_updated_idx" ON "watch_progress" USING btree ("profile_id","updated_at");--> statement-breakpoint
CREATE INDEX "watch_progress_item_idx" ON "watch_progress" USING btree ("item_id");