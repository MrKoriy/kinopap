import { sql } from "drizzle-orm";
import {
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

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

/**
 * Ошибки клиентов и серверов (web, api, worker): своя лента для страницы
 * «Ops» и алертов; при SENTRY_DSN они же уходят в Sentry. Одинаковые
 * ошибки склеиваются по fingerprint (count растёт, last_seen двигается).
 */
export const errorEvents = pgTable(
  "error_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    source: varchar("source", { length: 16 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    page: varchar("page", { length: 200 }),
    release: varchar("release", { length: 64 }),
    count: integer("count").notNull().default(1),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().default(sql`now()`),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("error_events_fp_uq").on(t.source, t.fingerprint),
    index("error_events_last_seen_idx").on(t.lastSeen),
  ],
);

/**
 * Каналы уведомлений пользователя: Telegram-чат или web push подписка
 * браузера. target — chat_id или endpoint; keys — p256dh/auth для push.
 */
export const notifyChannels = pgTable(
  "notify_channels",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(),
    target: text("target").notNull(),
    keys: jsonb("keys").$type<{ p256dh: string; auth: string }>(),
    label: varchar("label", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("notify_channels_kind_target_uq").on(t.kind, t.target), index("notify_channels_user_idx").on(t.userId)],
);

/** Одноразовые коды привязки Telegram: /start <code> в боте → канал пользователя. */
export const notifyLinkCodes = pgTable("notify_link_codes", {
  code: varchar("code", { length: 32 }).primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
