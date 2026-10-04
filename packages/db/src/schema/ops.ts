import { sql } from "drizzle-orm";
import {
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Курсоры и состояние фоновых задач Catalog Daemon (tmdb-changes, tmdb-feeds,
 * anilibria-updates, gap-filler…): где остановились, когда шли последний раз,
 * чем закончились. Одна строка на задачу.
 */
export const syncState = pgTable("sync_state", {
  key: varchar("key", { length: 64 }).primaryKey(),
  /** Курсор задачи (дата последнего /changes, страница и т.п.). */
  cursor: text("cursor"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  /** Итог последнего прогона: счётчики задачи. */
  stats: jsonb("stats").$type<Record<string, unknown>>(),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * RUM-метрики с клиентов: Web Vitals (LCP, TTFB, FCP, INP, CLS) и TTFF
 * плеера. Сырые события — сводка p50/p75/p95 считается запросом; старше
 * 30 дней чистит API.
 */
export const rumEvents = pgTable(
  "rum_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: varchar("name", { length: 16 }).notNull(),
    value: doublePrecision("value").notNull(),
    /** Маршрут без id: /item/[id], /watch, / … */
    page: varchar("page", { length: 120 }),
    itemId: integer("item_id"),
    /** Оценка web-vitals: good | needs-improvement | poor. */
    rating: varchar("rating", { length: 24 }),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index("rum_events_name_created_idx").on(t.name, t.createdAt)],
);
