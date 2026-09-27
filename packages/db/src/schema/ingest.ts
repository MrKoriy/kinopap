import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { items } from "./catalog";
import { media } from "./media";

/**
 * Задачи ingest: кто и что тянул в каталог и чем закончилось.
 * Источник — source-agnostic ref (путь или URL), никакой семантики пираток.
 */
export const ingestJobs = pgTable(
  "ingest_jobs",
  {
    id: serial("id").primaryKey(),
    sourceType: varchar("source_type", { length: 16 }).notNull(),
    sourceRef: text("source_ref").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    itemId: integer("item_id").references(() => items.id, { onDelete: "set null" }),
    mediaId: integer("media_id").references(() => media.id, { onDelete: "set null" }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ingest_jobs_status_idx").on(t.status),
    // Опрос статусов: свежие задачи статуса.
    index("ingest_jobs_status_created_idx").on(t.status, t.createdAt),
  ],
);

export type IngestJobStatus = "queued" | "running" | "done" | "failed";
