import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (_t) => [
    index("people_name_trgm").using("gin", sql`name gin_trgm_ops`),
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
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.personId, t.role] }),
    index("item_people_person_idx").on(t.personId),
    index("item_people_role_idx").on(t.role),
  ],
);
