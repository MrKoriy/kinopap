import { z } from "zod";
import {
  type AudioDubType,
  audioDubTypeSchema,
  type GenreType,
  genreTypeSchema,
  type ItemType,
  itemTypeSchema,
} from "./common";

/* ---------- Сортировка ---------- */

export const SORT_FIELDS = [
  "id",
  "year",
  "title",
  "rating",
  "views",
  "created",
  "updated",
] as const;
export const sortFieldSchema = z.enum(SORT_FIELDS);
export const sortDirSchema = z.enum(["asc", "desc"]);
export type SortField = z.infer<typeof sortFieldSchema>;
export type SortDir = z.infer<typeof sortDirSchema>;

export interface SortSpec {
  field: SortField;
  dir: SortDir;
}

/**
 * Разбор сортировки в стиле kino.pub: "updated-" (по убыванию), "year" (по возрастанию).
 * По умолчанию — updated по убыванию.
 */
export function parseSort(raw: string | undefined): SortSpec {
  if (!raw) return { field: "updated", dir: "desc" };
  const dir: SortDir = raw.endsWith("-") ? "desc" : "asc";
  const fieldRaw = raw.replace(/-$/, "");
  const parsed = sortFieldSchema.safeParse(fieldRaw);
  if (!parsed.success) return { field: "updated", dir: "desc" };
  return { field: parsed.data, dir };
}

/** "1990-2000" → {from:1990, to:2000}; "2001" → {from:2001, to:2001}. */
export function parseYearRange(
  raw: string | undefined,
): { yearFrom?: number; yearTo?: number } {
  if (!raw) return {};
  let m = raw.match(/^(\d{4})(?:-(\d{4})?)?$/);
  if (m) {
    const yearFrom = Number(m[1]);
    const yearTo = m[2] ? Number(m[2]) : yearFrom;
    return { yearFrom, yearTo };
  }
  // yearTo-only: "-2020"
  m = raw.match(/^-\s*(\d{4})$/);
  if (m) return { yearTo: Number(m[1]) };
  return {};
}

/** CSV из id: "1,2,3" → [1,2,3]; мусор отбрасывается. */
export function parseCsvInts(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : undefined;
}

/* ---------- Запросы ---------- */

/** Сырой HTTP-запрос списка (всё приходит строками из query). */
export const catalogRawQuerySchema = z.object({
  type: itemTypeSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  genre: z.string().optional(),
  country: z.string().optional(),
  year: z.string().optional(),
  letter: z.string().trim().min(1).max(1).optional(),
  actor: z.string().trim().min(1).max(200).optional(),
  director: z.string().trim().min(1).max(200).optional(),
  /** Рейтинг от N (0–10): свой рейтинг, иначе IMDb, иначе Кинопоиск. */
  rating: z.coerce.number().min(0).max(10).optional(),
  sort: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type CatalogRawQuery = z.infer<typeof catalogRawQuerySchema>;

/** Разобранные фильтры — их принимает слой репозиториев. */
export interface CatalogFilters {
  type?: ItemType;
  title?: string;
  genreIds?: number[];
  countryIds?: number[];
  yearFrom?: number;
  yearTo?: number;
  letter?: string;
  actor?: string;
  director?: string;
  ratingMin?: number;
  sort: SortSpec;
  limit: number;
  cursor?: string | null;
}

export function parseCatalogQuery(raw: unknown): CatalogFilters {
  const q = catalogRawQuerySchema.parse(raw);
  const { yearFrom, yearTo } = parseYearRange(q.year);
  return {
    type: q.type,
    title: q.title,
    genreIds: parseCsvInts(q.genre),
    countryIds: parseCsvInts(q.country),
    yearFrom,
    yearTo,
    letter: q.letter,
    actor: q.actor,
    director: q.director,
    ratingMin: q.rating && q.rating > 0 ? q.rating : undefined,
    sort: parseSort(q.sort),
    limit: q.limit,
    cursor: q.cursor ?? null,
  };
}

export const searchRawQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  type: itemTypeSchema.optional(),
  field: z.enum(["title", "director", "cast"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchRawQuery = z.infer<typeof searchRawQuerySchema>;

export const shortcutQuerySchema = z.object({
  type: itemTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

/**
 * Батч карточек: ids — CSV положительных int (максимум 50). Мусорный токен
 * и превышение cap — обычные ошибки валидации (400 validation_error).
 */
export const itemsSummaryQuerySchema = z.object({
  ids: z.string().transform((raw, ctx) => {
    const ids: number[] = [];
    for (const part of raw.split(",")) {
      const token = part.trim();
      const n = Number(token);
      if (token === "" || !Number.isInteger(n) || n <= 0) {
        ctx.addIssue({
          code: "custom",
          message: `ids: «${token}» is not a positive integer`,
        });
        continue;
      }
      ids.push(n);
    }
    if (ids.length > 50) {
      ctx.addIssue({ code: "custom", message: "ids: maximum 50 values" });
    }
    return ids;
  }),
});
export type ItemsSummaryQuery = z.infer<typeof itemsSummaryQuerySchema>;

/* ---------- DTO ---------- */

export const genreRefSchema = z.object({
  id: z.number().int(),
  title: z.string(),
});
export const genreSchema = genreRefSchema.extend({ type: genreTypeSchema });
export const countrySchema = z.object({ id: z.number().int(), title: z.string() });

export type GenreRef = z.infer<typeof genreRefSchema>;
export type Genre = z.infer<typeof genreSchema>;
export type Country = z.infer<typeof countrySchema>;

export const itemSummarySchema = z.object({
  id: z.number().int(),
  type: itemTypeSchema,
  subtype: z.string().nullable(),
  title: z.string(),
  originalTitle: z.string().nullable(),
  year: z.number().int().nullable(),
  plot: z.string().nullable(),
  cast: z.array(z.string()),
  director: z.array(z.string()),
  duration: z.object({
    average: z.number().int().nullable(),
    total: z.number().int().nullable(),
  }),
  langs: z.number().int(),
  ac3: z.boolean(),
  quality: z.number().int().nullable(),
  genres: z.array(genreRefSchema),
  countries: z.array(countrySchema),
  imdb: z.object({
    id: z.number().int().nullable(),
    rating: z.number().nullable(),
    votes: z.number().int().nullable(),
  }),
  kinopoisk: z.object({
    id: z.number().int().nullable(),
    rating: z.number().nullable(),
    votes: z.number().int().nullable(),
  }),
  tmdb: z.object({
    id: z.number().int().nullable(),
    rating: z.number().nullable(),
    votes: z.number().int().nullable(),
  }),
  rating: z.number(),
  votes: z.object({
    positive: z.number().int(),
    negative: z.number().int(),
    total: z.number().int(),
  }),
  views: z.number().int(),
  finished: z.boolean().nullable(),
  advert: z.boolean(),
  posters: z.object({
    small: z.string().nullable(),
    medium: z.string().nullable(),
    big: z.string().nullable(),
  }),
  trailer: z.object({
    id: z.string().nullable(),
    url: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ItemSummary = z.infer<typeof itemSummarySchema>;

export const episodeSchema = z.object({
  id: z.number().int(),
  number: z.number().int(),
  title: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  runtime: z.number().int(),
  mediaId: z.number().int().nullable(),
});
export const seasonSchema = z.object({
  id: z.number().int(),
  number: z.number().int(),
  title: z.string().nullable(),
  episodes: z.array(episodeSchema),
});
export const mediaPartSchema = z.object({
  id: z.number().int(),
  partNumber: z.number().int(),
  title: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  runtime: z.number().int(),
});

export type Episode = z.infer<typeof episodeSchema>;
export type Season = z.infer<typeof seasonSchema>;
export type MediaPart = z.infer<typeof mediaPartSchema>;

export const itemDetailSchema = itemSummarySchema.extend({
  seasons: z.array(seasonSchema).nullable(),
  media: z.array(mediaPartSchema).nullable(),
});
export type ItemDetail = z.infer<typeof itemDetailSchema>;

export const itemPageSchema = z.object({
  items: z.array(itemSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ItemPage = z.infer<typeof itemPageSchema>;

/** Батч карточек по id: без пагинации, порядок — как в ids запроса. */
export const itemsSummaryResponseSchema = z.object({
  items: z.array(itemSummarySchema),
});
export type ItemsSummaryResponse = z.infer<typeof itemsSummaryResponseSchema>;

/* ---------- Media links ---------- */

export const mediaFileSchema = z.object({
  quality: z.string(),
  qualityId: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  codec: z.string(),
  bitrate: z.number().int().nullable(),
  sizeBytes: z.number().nullable(),
  urls: z.object({
    http: z.string(),
    hls: z.string().nullable(),
  }),
});
export const audioTrackSchema = z.object({
  id: z.number().int(),
  index: z.number().int(),
  codec: z.string(),
  channels: z.number().int(),
  lang: z.string(),
  type: audioDubTypeSchema,
  author: z.object({
    title: z.string().nullable(),
    shortTitle: z.string().nullable(),
  }),
  /** Плейлист аудио-рендitions из HLS-мастера (null для старых записей). */
  url: z.string().nullable(),
  /**
   * Персональный мастер этого дубляжа (видео-лестница + одна аудио-группа).
   * Для плееров без API выбора аудио (нативный HLS на мобиле).
   */
  masterUrl: z.string().nullable(),
});
export const subtitleSchema = z.object({
  id: z.number().int(),
  lang: z.string(),
  shiftMs: z.number().int(),
  embed: z.boolean(),
  title: z.string().nullable(),
  url: z.string().nullable(),
});

export type MediaFile = z.infer<typeof mediaFileSchema>;
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type Subtitle = z.infer<typeof subtitleSchema>;

/** Спрайт для скраббинга: картинка + раскладка тайлов. */
export const spriteMetaSchema = z.object({
  url: z.string(),
  intervalSeconds: z.number(),
  tileWidth: z.number().int(),
  tileHeight: z.number().int(),
  columns: z.number().int(),
  rows: z.number().int(),
  count: z.number().int(),
});
export type SpriteMetaDto = z.infer<typeof spriteMetaSchema>;

/** Маркер интро: кнопка «пропустить интро» в этом диапазоне. */
export const introMarkerSchema = z.object({
  startSeconds: z.number(),
  endSeconds: z.number(),
});
export type IntroMarker = z.infer<typeof introMarkerSchema>;

export const mediaLinksSchema = z.object({
  mediaId: z.number().int(),
  itemId: z.number().int(),
  files: z.array(mediaFileSchema),
  audios: z.array(audioTrackSchema),
  subtitles: z.array(subtitleSchema),
  posterUrl: z.string().nullable(),
  sprites: spriteMetaSchema.nullable(),
  intro: introMarkerSchema.nullable(),
});
export type MediaLinks = z.infer<typeof mediaLinksSchema>;

/**
 * Тепловые метаданные прогретого релиза: хеш торрента в TorrServer и точный
 * индекс видеофайла. Нужны резолверу и ленивым аудио-дорожкам; в
 * media-links наружу не отдаются — магнит-ссылки клиенту не положены.
 */
export interface WarmRelease {
  hash: string;
  fileIndex: number;
  magnet: string;
  title: string;
}

/** Ленивые аудио-дорожки: gst-проба уже выполненного прогрева. */
export const mediaTracksSchema = z.object({
  mediaId: z.number().int(),
  itemId: z.number().int(),
  audios: z.array(audioTrackSchema),
});
export type MediaTracks = z.infer<typeof mediaTracksSchema>;

/* ---------- Мета ---------- */

export const typeInfoSchema = z.object({
  id: itemTypeSchema,
  title: z.string(),
});
export const typesResponseSchema = z.object({
  types: z.array(typeInfoSchema),
});
export const genresResponseSchema = z.object({ genres: z.array(genreSchema) });
export const countriesResponseSchema = z.object({
  countries: z.array(countrySchema),
});

export type { AudioDubType, GenreType, ItemType };
