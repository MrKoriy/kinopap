import type { AudioTrack, IntroMarker, MediaFile, WarmRelease } from "@zal/api-client";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { episodes, items } from "./catalog";
import { audioDubType, mediaQuality } from "./enums";

/** Метаданные спрайта для скраббинга плеера. */
export interface SpriteMeta {
  intervalSeconds: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  count: number;
}

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
    posterKey: text("poster_key"),
    spriteKey: text("sprite_key"),
    spriteMeta: jsonb("sprite_meta").$type<SpriteMeta | null>(),
    introStartSeconds: integer("intro_start_seconds"),
    introEndSeconds: integer("intro_end_seconds"),
    /** Хэш источника: повторный ingest того же ref обновляет запись, не дублируя. */
    sourceKey: varchar("source_key", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("media_item_idx").on(t.itemId),
    index("media_episode_idx").on(t.episodeId),
    // getItem сортирует media по part_number — композит вместо сортировки.
    index("media_item_part_idx").on(t.itemId, t.partNumber),
    uniqueIndex("media_item_source_uq").on(t.itemId, t.sourceKey),
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
    quality: mediaQuality("quality").notNull(),
    qualityId: integer("quality_id").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    codec: varchar("codec", { length: 16 }).notNull().default("h264"),
    bitrate: integer("bitrate"),
    // bigint: 4K-ремуксы в 8-60 ГБ в integer (~2.1 ГБ) не влезают.
    sizeBytes: bigint("size_bytes", { mode: "number" }),
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
    /** Персональный мастер-плейлист этого дубляжа (видео-лестница + одна аудио-группа).
     * Нужен плеерам без API выбора аудио (нативный HLS на мобиле). */
    masterKey: text("master_key"),
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

/**
 * Кэш zero-storage резолва: ссылки и прогретый релиз по паре (item, media).
 * Живёт в БД, а не в памяти API: рестарт/деплой больше не обнуляет
 * прогрев — warm переживает redeploy и отдаёт аудио-дорожки сразу.
 */
export const mediaSources = pgTable(
  "media_sources",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    mediaId: integer("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    files: jsonb("files").$type<MediaFile[]>().notNull(),
    audios: jsonb("audios").$type<AudioTrack[]>().notNull(),
    intro: jsonb("intro").$type<IntroMarker | null>(),
    /** Хеш и индекс файла в TorrServer — то, ради чего вся таблица. */
    warm: jsonb("warm").$type<WarmRelease | null>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.mediaId] }),
    index("media_sources_resolved_at_idx").on(t.resolvedAt),
  ],
);
