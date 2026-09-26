import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { audioDubType } from "./enums";
import { episodes, items } from "./catalog";

/**
 * Проигрываемая единица: у фильмов/концертов привязана к item напрямую,
 * у сериалов — к эпизоду. Дальше — лестница качеств, аудио и субтитры.
 */
export const media = pgTable(
  "media",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    episodeId: integer("episode_id").references(() => episodes.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull().default(1),
    title: varchar("title", { length: 255 }),
    thumbnailUrl: text("thumbnail_url"),
    runtime: integer("runtime").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("media_item_idx").on(t.itemId),
    index("media_episode_idx").on(t.episodeId),
  ],
);

/** Лестница качеств: 480p/720p/1080p/2160p — ключи в S3-совместимом хранилище. */
export const mediaFiles = pgTable(
  "media_files",
  {
    id: serial("id").primaryKey(),
    mediaId: integer("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    quality: varchar("quality", { length: 16 }).notNull(),
    qualityId: integer("quality_id").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    codec: varchar("codec", { length: 16 }).notNull().default("h264"),
    bitrate: integer("bitrate"),
    sizeBytes: integer("size_bytes"),
    fileKey: text("file_key").notNull(),
    hlsKey: text("hls_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("media_files_media_quality_uq").on(t.mediaId, t.quality)],
);

/** Аудиодорожки с метаданными дубляжа (MVO/UVO/DVO/AVO/оригинал, автор). */
export const audioTracks = pgTable(
  "audio_tracks",
  {
    id: serial("id").primaryKey(),
    mediaId: integer("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    trackIndex: integer("track_index").notNull().default(0),
    codec: varchar("codec", { length: 16 }).notNull().default("aac"),
    channels: integer("channels").notNull().default(2),
    lang: varchar("lang", { length: 8 }).notNull().default("rus"),
    dubType: audioDubType("dub_type").notNull().default("mvo"),
    authorTitle: varchar("author_title", { length: 120 }),
    authorShortTitle: varchar("author_short_title", { length: 120 }),
    fileKey: text("file_key"),
  },
  (t) => [index("audio_tracks_media_idx").on(t.mediaId)],
);

/** Субтитры: язык, сдвиг (мс), вшиты в файл или отдельным файлом. */
export const subtitles = pgTable(
  "subtitles",
  {
    id: serial("id").primaryKey(),
    mediaId: integer("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    lang: varchar("lang", { length: 8 }).notNull(),
    shiftMs: integer("shift_ms").notNull().default(0),
    embed: boolean("embed").notNull().default(false),
    title: varchar("title", { length: 64 }),
    fileKey: text("file_key"),
  },
  (t) => [index("subtitles_media_idx").on(t.mediaId)],
);
