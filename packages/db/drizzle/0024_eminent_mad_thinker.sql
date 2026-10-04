CREATE TABLE "error_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" varchar(16) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"page" varchar(200),
	"release" varchar(64),
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notify_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"target" text NOT NULL,
	"keys" jsonb,
	"label" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notify_link_codes" (
	"code" varchar(32) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "notified_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notify_channels" ADD CONSTRAINT "notify_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify_link_codes" ADD CONSTRAINT "notify_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "error_events_fp_uq" ON "error_events" USING btree ("source","fingerprint");--> statement-breakpoint
CREATE INDEX "error_events_last_seen_idx" ON "error_events" USING btree ("last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX "notify_channels_kind_target_uq" ON "notify_channels" USING btree ("kind","target");--> statement-breakpoint
CREATE INDEX "notify_channels_user_idx" ON "notify_channels" USING btree ("user_id");