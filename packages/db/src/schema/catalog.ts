import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
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
import { genreType, itemType, personRole } from "./enums";

export const genres = pgTable(
  "genres",
  {
    id: serial("id").primaryKey(),
    type: genreType("type").notNull(),
    title: varchar("title", { length: 120 }).notNull(),
  },
  (t) => [uniqueIndex("genres_type_title_uq").on(t.type, t.title)],
);

export const countries = pgTable("countries", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 120 }).notNull().unique(),
});

export const items = pgTable(
  "items",
  {
    id: serial("id").primaryKey(),
    type: itemType("type").notNull(),
    subtype: varchar("subtype", { length: 32 }),
    title: varchar("title", { length: 255 }).notNull(),
    originalTitle: varchar("original_title", { length: 255 }),
    year: integer("year"),
    plot: text("plot"),
    runtimeAvg: integer("runtime_avg"),
    runtimeTotal: integer("runtime_total"),
    langs: integer("langs").notNull().default(1),
    hasAc3: boolean("has_ac3").notNull().default(false),
    quality: integer("quality"),
    imdbId: integer("imdb_id"),
    imdbRating: doublePrecision("imdb_rating"),
    imdbVotes: integer("imdb_votes"),
    kinopoiskId: integer("kinopoisk_id"),
    kinopoiskRating: doublePrecision("kinopoisk_rating"),
    kinopoiskVotes: integer("kinopoisk_votes"),
    /**
     * Внешний источник и его id (anilibria:123). Позволяет резолвить стрим
     * без поиска по названию: у аниме «Наруто» под русским и английским
     * названием в торрент-трекерах разная выдача, а тут id — истина.
     */
    externalSource: varchar("external_source", { length: 32 }),
    externalId: varchar("external_id", { length: 64 }),
    tmdbId: integer("tmdb_id"),
    /**
     * Раскладка сезонов, если её перестроили (`tmdb-group:<id>`). Пусто —
     * сезоны как у источника. Нужна импорту: новые серии регрупнутого
     * тайтла дописываются в последний сезон, а не в «Сезон 1» источника.
     */
    seasonLayout: varchar("season_layout", { length: 64 }),
    /** Когда последний раз брали локализованное название из /translations TMDb. */
    titleLocalizedAt: timestamp("title_localized_at", { withTimezone: true }),
    /** Резолв первой серии/фильма не нашёл ни одной раздачи (подряд) — прячем из лент. */
    noSourceCount: integer("no_source_count").notNull().default(0),
    noSourceAt: timestamp("no_source_at", { withTimezone: true }),
    /**
     * Можно ли смотреть: true — у тайтла есть проверенная (good) раздача
     * в stream_sources, false — stream-precheck проверял и не нашёл ничего
     * живого, null — ещё не проверяли (не обещаем и не прячем).
     */
    playable: boolean("playable"),
    /** Когда релиз AniLibria сверяли с поиском TMDb (повтор через 30 дней). */
    tmdbMatchedAt: timestamp("tmdb_matched_at", { withTimezone: true }),
    tmdbType: varchar("tmdb_type", { length: 8 }),
    tmdbRating: doublePrecision("tmdb_rating"),
    tmdbVotes: integer("tmdb_votes"),
    rating: doublePrecision("rating").notNull().default(0),
    votesPositive: integer("votes_positive").notNull().default(0),
    votesNegative: integer("votes_negative").notNull().default(0),
    views: integer("views").notNull().default(0),
    finished: boolean("finished"),
    advert: boolean("advert").notNull().default(false),
    posterSmall: text("poster_small"),
    posterMedium: text("poster_medium"),
    posterBig: text("poster_big"),
    trailerId: varchar("trailer_id", { length: 64 }),
    trailerUrl: text("trailer_url"),
    /** Негативный кэш трейлера: TMDb /videos ответил «нет» в это время.
     * Пусто — трейлер ещё не искали. Ретрай «нет трейлера» — раз в 90 дней:
     * ролики появляются после релиза, вечная пометка была бы ложью. */
    trailerCheckedAt: timestamp("trailer_checked_at", { withTimezone: true }),
    /** Бэкдроп TMDb (w1280) — OG-картинка и фон шапки тайтла. */
    backdropUrl: text("backdrop_url"),
    /** Когда тянули /credits TMDb (актёры и команда). Пусто — ещё не тянули. */
    creditsCheckedAt: timestamp("credits_checked_at", { withTimezone: true }),
    /** AniList: id тайтла и когда искали франшизу (повтор — раз в 30 дней). */
    anilistId: integer("anilist_id"),
    anilistCheckedAt: timestamp("anilist_checked_at", { withTimezone: true }),
    franchiseId: integer("franchise_id"),
    /**
     * Свои нарезки картинок (MEDIA_ROOT/img/<hash>/…): контент-хеш исходника.
     * Пусто — файлов нет, веб идёт старым путём через next/image.
     */
    posterHash: varchar("poster_hash", { length: 40 }),
    backdropHash: varchar("backdrop_hash", { length: 40 }),
    posterBlurhash: varchar("poster_blurhash", { length: 64 }),
    /** Доминантный цвет постера «#rrggbb» — фон плейсхолдера и шапки. */
    dominantColor: varchar("dominant_color", { length: 7 }),
    imagesCheckedAt: timestamp("images_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // items_type_idx удалён: полностью покрывается тремя (type, …)
    // композитами ниже — отдельный индекс по type был чистой
    // write-амплфикацией на insert-heavy заливке каталога.
    index("items_year_idx").on(t.year),
    index("items_rating_idx").on(t.rating),
    index("items_views_idx").on(t.views),
    index("items_created_idx").on(t.createdAt),
    index("items_updated_idx").on(t.updatedAt),
    // sort=title без b-tree — всегда filesort.
    index("items_title_idx").on(t.title),
    // Дедуп discovery-импорта: tmdbId + (title, year) — по 15к+ поисков за fill.
    index("items_tmdb_id_idx").on(t.tmdbId),
    index("items_tmdb_type_idx").on(t.tmdbType),
    uniqueIndex("items_tmdb_type_id_uq")
      .on(t.tmdbType, t.tmdbId)
      .where(sql`(tmdb_type IS NOT NULL) AND (tmdb_id IS NOT NULL)`),
    // Дедуп и резолв по внешнему источнику (anilibria и дальше).
    uniqueIndex("items_external_uq").on(t.externalSource, t.externalId),
    index("items_title_year_idx").on(t.title, t.year),
    // Композиты под shortcuts: фильтр типа + сортировка fresh/hot/popular.
    index("items_type_year_idx").on(t.type, t.year),
    index("items_type_views_idx").on(t.type, t.views),
    index("items_type_rating_idx").on(t.type, t.rating),
    // Поиск по триграммам (pg_trgm) — включается в миграции.
    index("items_title_trgm").using("gin", sql`title gin_trgm_ops`),
    index("items_original_title_trgm").using("gin", sql`original_title gin_trgm_ops`),
    index("items_franchise_idx").on(t.franchiseId),
  ],
);

export const seasons = pgTable(
  "seasons",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: varchar("title", { length: 255 }),
  },
  (t) => [uniqueIndex("seasons_item_number_uq").on(t.itemId, t.number)],
);

export const episodes = pgTable(
  "episodes",
  {
    id: serial("id").primaryKey(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: varchar("title", { length: 255 }),
    plot: text("plot"),
    runtime: integer("runtime").notNull().default(0),
    thumbnailUrl: text("thumbnail_url"),
    airDate: timestamp("air_date", { withTimezone: true }),
    /**
     * Координаты серии у источника (TMDb S/E, у AniLibria — 1/ordinal).
     * После перестройки сезонов season/number — наша раскладка, а резолвер
     * и импорт ищут серию по этим полям. NULL — совпадают с season/number.
     */
    origSeason: integer("orig_season"),
    origNumber: integer("orig_number"),
    /** Сквозной номер серии (245-я серия «Блича») — для подписи и торрентов. */
    absoluteNumber: integer("absolute_number"),
  },
  (t) => [uniqueIndex("episodes_season_number_uq").on(t.seasonId, t.number)],
);

export const itemGenres = pgTable(
  "item_genres",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    genreId: integer("genre_id")
      .notNull()
      .references(() => genres.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.genreId] })],
);

export const itemCountries = pgTable(
  "item_countries",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    countryId: integer("country_id")
      .notNull()
      .references(() => countries.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.countryId] }),
    index("item_countries_country_idx").on(t.countryId),
  ],
);

export const people = pgTable(
  "people",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    nameEn: varchar("name_en", { length: 255 }),
    photoUrl: text("photo_url"),
    /** id персоны в TMDb — дедуп людей между тайтлами. */
    tmdbId: integer("tmdb_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("people_name_trgm").using("gin", sql`name gin_trgm_ops`),
    uniqueIndex("people_tmdb_uq").on(t.tmdbId).where(sql`tmdb_id IS NOT NULL`),
  ],
);

export const itemPeople = pgTable(
  "item_people",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    role: personRole("role").notNull(),
    characterName: varchar("character_name", { length: 255 }),
    /** Порядок в титрах TMDb: топ актёров — первые по ord. */
    ord: integer("ord").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.personId, t.role] }),
    index("item_people_person_idx").on(t.personId),
    index("item_people_role_idx").on(t.role),
  ],
);

/**
 * Карточка влита в другую (склейка дублей): старые ссылки /item/<from>
 * ведут на выжившую <to>, а не в 404.
 */
export const itemRedirects = pgTable("item_redirects", {
  fromId: integer("from_id").primaryKey(),
  toId: integer("to_id")
    .notNull()
    .references(() => items.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Дополнительные релизы источника, влитые в сезон тайтла: «Магическая битва 2»
 * AniLibria → сезон 2 TMDb-тайтла. Повторный импорт релиза находит по алиасу
 * карточку и сезон (у items одна пара external_* — под релиз первого сезона).
 */
export const itemExternalAliases = pgTable(
  "item_external_aliases",
  {
    source: varchar("source", { length: 32 }).notNull(),
    externalId: varchar("external_id", { length: 64 }).notNull(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    seasonNumber: integer("season_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.source, t.externalId] })],
);

/**
 * Франшиза аниме по связям AniList (PREQUEL/SEQUEL/SIDE_STORY…): сезоны,
 * фильмы, OVA и спешлы одной вселенной. Ключ — минимальный AniList-id
 * компоненты связности: тот же граф из любой точки даёт ту же франшизу.
 */
export const franchises = pgTable("franchises", {
  id: serial("id").primaryKey(),
  anilistRootId: integer("anilist_root_id").notNull().unique(),
  title: varchar("title", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Части франшизы в порядке выхода; item_id — наша карточка, если нашлась. */
export const franchiseEntries = pgTable(
  "franchise_entries",
  {
    franchiseId: integer("franchise_id")
      .notNull()
      .references(() => franchises.id, { onDelete: "cascade" }),
    anilistId: integer("anilist_id").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    /** Формат AniList: TV, TV_SHORT, MOVIE, OVA, ONA, SPECIAL. */
    format: varchar("format", { length: 16 }),
    year: integer("year"),
    episodes: integer("episodes"),
    sortOrder: integer("sort_order").notNull().default(0),
    itemId: integer("item_id").references(() => items.id, { onDelete: "set null" }),
  },
  (t) => [
    primaryKey({ columns: [t.franchiseId, t.anilistId] }),
    index("franchise_entries_item_idx").on(t.itemId),
  ],
);

/** Ручная раскладка сезонов: группа = сезон, серии — координаты источника [S, E]. */
export interface SeasonOverrideLayout {
  groups: Array<{ title: string | null; eps: Array<[number, number]> }>;
}

/**
 * Ручные раскладки для редких сложных тайтлов. quality-audit применяет
 * новые/изменённые (applied_at пуст или старше updated_at) через
 * applySeasonLayout — серии переносятся, id и прогресс сохраняются.
 */
export const seasonOverrides = pgTable("season_overrides", {
  itemId: integer("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  layout: jsonb("layout").$type<SeasonOverrideLayout>().notNull(),
  note: text("note"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Аномалии каталога из ночного quality-audit: одна строка на (тайтл, вид).
 * status: open — висит, fixed — автофикс, resolved — больше не воспроизводится,
 * ignored — человек решил «так и задумано» (аудит её не переоткрывает).
 */
export const qualityAnomalies = pgTable(
  "quality_anomalies",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("quality_anomalies_item_kind_uq").on(t.itemId, t.kind),
    index("quality_anomalies_status_idx").on(t.status, t.kind),
  ],
);
