import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { items } from "./catalog";
import { watchStatus } from "./enums";
import { media } from "./media";
import { profiles } from "./users";

/** Прогресс просмотра: позиция и статус по каждому media профиля. */
export const watchProgress = pgTable(
  "watch_progress",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    mediaId: integer("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    positionSeconds: integer("position_seconds").notNull().default(0),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    status: watchStatus("status").notNull().default("unwatched"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("watch_progress_profile_media_uq").on(t.profileId, t.mediaId),
    index("watch_progress_profile_updated_idx").on(t.profileId, t.updatedAt),
    index("watch_progress_item_idx").on(t.itemId),
  ],
);

/**
 * Сохранённое («Смотреть позже»): личный список тайтлов без подписки на
 * обновления. Отдельно от подписок — подписка это про уведомления о новых
 * сериях, закладка — про «вернусь к этому».
 */
export const favorites = pgTable(
  "favorites",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("favorites_profile_item_uq").on(t.profileId, t.itemId),
    // Лента «Сохранённое» — свежие сверху.
    index("favorites_profile_created_idx").on(t.profileId, t.createdAt),
    index("favorites_item_idx").on(t.itemId),
  ],
);

/** Подписка на сериал (in_watchlist у kino.pub): ждём новые серии. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    notify: boolean("notify").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subscriptions_profile_item_uq").on(t.profileId, t.itemId),
    index("subscriptions_item_idx").on(t.itemId),
  ],
);

/** Голоса за контент: like/dislike, суммы держим в items. */
export const votes = pgTable(
  "votes",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    positive: boolean("positive").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("votes_profile_item_uq").on(t.profileId, t.itemId)],
);

/** Максимальная глубина вложенности ответов (дальше отвечаем на уровень ниже). */
export const MAX_COMMENT_DEPTH = 6;

/** Дерево комментариев (parent_id + depth). */
export const comments = pgTable(
  "comments",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    // Self-FK: родитель обязан существовать. ON DELETE не указан (NO ACTION):
    // жёсткого удаления веток в коде нет (soft-delete), а каскад item_id
    // сносит всё дерево одной командой, что NO ACTION допускает.
    parentId: integer("parent_id").references((): AnyPgColumn => comments.id),
    depth: integer("depth").notNull().default(0),
    body: text("body").notNull(),
    deleted: boolean("deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("comments_item_created_idx").on(t.itemId, t.createdAt),
    index("comments_parent_idx").on(t.parentId),
    // BFS веток: фильтр item + parent в одном скане.
    index("comments_item_parent_idx").on(t.itemId, t.parentId),
    // Дубликат MAX_COMMENT_DEPTH из repos/social на стороне БД: клампы в
    // коде не спасают от кривых записей извне. sql.raw, а не параметр:
    // биндинг в CHECK drizzle-kit рендерит как $1.
    check("comments_depth_check", sql.raw(`depth <= ${MAX_COMMENT_DEPTH}`)),
  ],
);

/** Пользовательские списки («хочу посмотреть» и т.п.). */
export const lists = pgTable(
  "lists",
  {
    id: serial("id").primaryKey(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 160 }).notNull(),
    description: text("description"),
    isPublic: boolean("is_public").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lists_profile_idx").on(t.profileId)],
);

export const listEntries = pgTable(
  "list_items",
  {
    listId: integer("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.itemId] }),
    index("list_items_item_idx").on(t.itemId),
  ],
);
