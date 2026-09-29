/**
 * Наполнение каталога из TMDb: тренды, fill по годам, жанровая матрица,
 * коллекции (целые франшизы), списки и страны.
 *
 * Живёт в @zal/ingest, а не в роуте API, — потому что запускается фоновой
 * джобой в воркере: 15–20к тайтлов это ~1500 запросов к TMDb и минуты работы,
 * а одиночный HTTP-запрос nginx оборвёт по таймауту.
 *
 * Запросы пейсятся (TMDb лимит ~40 rps) и ретраятся на 429, дедуп и запись —
 * батчами через @zal/db (insertCatalogBatch).
 */

import {
  type CatalogDraft,
  countCatalogItems,
  type Db,
  filterExistingTmdbIds,
  insertCatalogBatch,
  listLocalGenres,
  mergeCatalogDuplicates,
} from "@zal/db";
import { type AnimeImportSummary, importAnilibriaCatalog } from "./anilibria-import";
import { TMDB_IMAGE_BASE_URL, TmdbClient } from "./tmdb-client";

/** TMDb (ru) → локальные названия жанров из сида. */
const GENRE_ALIASES: Record<string, string> = {
  Боевик: "Боевик",
  Приключения: "Приключения",
  Анимация: "Мультфильм",
  Комедия: "Комедия",
  Преступление: "Криминал",
  Документальный: "Документальный",
  Драма: "Драма",
  Семья: "Семейный",
  Фэнтези: "Фэнтези",
  История: "Исторический",
  Ужасы: "Ужасы",
  Музыка: "Мюзикл",
  Детектив: "Детектив",
  Романтика: "Мелодрама",
  Фантастика: "Фантастика",
  Триллер: "Триллер",
  Война: "Военный",
  Вестерн: "Вестерн",
  Аниме: "Аниме",
  "Телешоу": "ТВ-шоу",
  "Научная фантастика": "Фантастика",
};

/** Жанровая матрица: добирает «хвост», не попавший в топ года по популярности. */
const MATRIX_GENRE_IDS = [
  28, 12, 16, 35, 80, 18, 10751, 14, 36, 27, 10402, 9648, 53, 10752, 878, 10749,
];

/** Десятилетия для жанровой матрицы (по два параметра-диапазона на запрос). */
const MATRIX_DECADES: Array<[number, number]> = [
  [1960, 1969],
  [1970, 1979],
  [1980, 1989],
  [1990, 1999],
  [2000, 2009],
  [2010, 2019],
  [2020, 2029],
];

/** Страны, чьи каталоги заметно отличаются от англоязычного «верха». */
const DEFAULT_COUNTRIES = ["KR", "JP", "IN", "CN", "FR", "DE", "ES", "IT", "BR", "MX"];

/**
 * Глубина discover по умолчанию, когда спека не задала страницы явно.
 *
 * Держим на потолке схемы (`packages/db/src/repos/discovery.ts`: yearPages ≤ 10,
 * genrePages ≤ 5, countryPages ≤ 5) — это и есть «потолок 15–20к» из шапки.
 * Операторский вход (`bin/fill-catalog.sh`) задаёт те же числа явно и умеет
 * опускать их через FILL_* — этот дефолт нужен только прямым вызовам fillCatalog.
 */
export const DEFAULT_FILL_PAGES = {
  yearPages: 10,
  genrePages: 5,
  countryPages: 5,
} as const;

export interface FillSpec {
  /** Годы массового fill: discover по году, сортировка по популярности. */
  years?: number[];
  /** Страниц discover на год (20 тайтлов на страницу). */
  yearPages?: number;
  minVotesMovie?: number;
  minVotesTv?: number;
  /** Жанровая матрица (хвост) — по десятилетиям × жанрам. */
  genreMatrix?: boolean;
  genrePages?: number;
  /** Имена коллекций TMDb: импортируются все части франшизы. */
  collections?: string[];
  /** top_rated + trending + популярное. */
  lists?: boolean;
  /** Discover по странам происхождения. */
  countries?: string[];
  /** Страниц на страну. */
  countryPages?: number;
  /** Импорт каталога AniLibria (аниме) после TMDb-сбора. */
  anime?: boolean;
  /** Сколько аниме-релизов максимум импортировать. */
  animeLimit?: number;
  /** Склейка дублей каталога после всех фаз (по умолчанию включена). */
  dedupe?: boolean;
}

export interface FillProgress {
  phase: "collect" | "insert" | "anime" | "dedupe" | "done";
  /** Сколько кандидатов уже собрано из TMDb. */
  fetched: number;
  /** Обработано батчей вставки. */
  processed: number;
  /** Сколько вставили и сколько пропустили (дедуп). */
  added: number;
  skipped: number;
  /** Тайтлов в каталоге на текущий момент. */
  total: number;
  /** Откуда уже собрано: years:77, collections:98 … */
  sources: string[];
  /** Прогресс импорта аниме (фаза "anime"). */
  anime?: { listed: number; added: number; episodes: number };
}

export interface FillSummary extends FillProgress {
  phase: "done";
  /** Найдено коллекций / не найдено. */
  collections?: { found: string[]; missing: string[] };
  /** Итог склейки дублей (фаза "dedupe"). */
  dedupe?: { candidates: number; merged: number };
  durationMs: number;
}

export interface FillOptions {
  db: Db;
  apiKey: string;
  spec?: FillSpec;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Базовый URL AniLibria для фазы аниме. */
  anilibriaBaseUrl?: string;
  onProgress?: (p: FillProgress) => void;
  /** Пауза между запросами к TMDb (лимит ~40 rps, берём с запасом). */
  requestIntervalMs?: number;
  /** Размер батча вставки в БД. */
  batchSize?: number;
}

type TmdbEntry = CatalogDraft;

function mapEntry(raw: Record<string, unknown>, type: "movie" | "serial", minVotes: number): TmdbEntry | null {
  const tmdbId = typeof raw.id === "number" ? raw.id : null;
  const title = String(raw.title ?? raw.name ?? "").trim();
  const posterPath = raw.poster_path ? String(raw.poster_path) : null;
  const votes = typeof raw.vote_count === "number" ? raw.vote_count : 0;
  if (!tmdbId || !title || !posterPath || votes < minVotes) return null;

  const date = String(raw.release_date ?? raw.first_air_date ?? "");
  const year = date.length >= 4 ? parseInt(date.slice(0, 4), 10) : null;
  const runtimeRaw =
    type === "movie"
      ? raw.runtime
      : Array.isArray(raw.episode_run_time)
        ? raw.episode_run_time[0]
        : null;
  const voteAvg = typeof raw.vote_average === "number" ? raw.vote_average : 0;

  return {
    tmdbId,
    type,
    title,
    originalTitle: raw.original_title ?? raw.original_name
      ? String(raw.original_title ?? raw.original_name)
      : null,
    year: year && year > 1900 ? year : null,
    plot: raw.overview ? String(raw.overview) : null,
    rating: voteAvg > 0 ? Math.round(voteAvg * 10) / 10 : 0,
    votes,
    runtime: typeof runtimeRaw === "number" && runtimeRaw > 0 ? runtimeRaw * 60 : null,
    posterSmall: `${TMDB_IMAGE_BASE_URL}/w185${posterPath}`,
    posterMedium: `${TMDB_IMAGE_BASE_URL}/w500${posterPath}`,
    posterBig: `${TMDB_IMAGE_BASE_URL}/original${posterPath}`,
    genreIds: Array.isArray(raw.genre_ids)
      ? raw.genre_ids.filter((g): g is number => typeof g === "number")
      : [],
  };
}

/** Детали фильма из коллекции: genres[] вместо genre_ids, runtime на месте. */
function mapDetail(raw: Record<string, unknown>, minVotes: number): TmdbEntry | null {
  const entry = mapEntry(raw, "movie", minVotes);
  if (!entry) return null;
  const gs = Array.isArray(raw.genres)
    ? raw.genres
        .map((g) => (typeof g === "object" && g ? (g as { id?: unknown }).id : null))
        .filter((id): id is number => typeof id === "number")
    : [];
  return { ...entry, genreIds: gs };
}

/** Части коллекции без деталей: genres/runtime доберём только для новых. */
function mapCollectionPart(raw: Record<string, unknown>): TmdbEntry | null {
  const tmdbId = typeof raw.id === "number" ? raw.id : null;
  const title = String(raw.title ?? "").trim();
  const posterPath = raw.poster_path ? String(raw.poster_path) : null;
  const votes = typeof raw.vote_count === "number" ? raw.vote_count : 0;
  if (!tmdbId || !title || votes < 10) return null;
  const date = String(raw.release_date ?? "");
  const year = date.length >= 4 ? parseInt(date.slice(0, 4), 10) : null;
  const voteAvg = typeof raw.vote_average === "number" ? raw.vote_average : 0;
  return {
    tmdbId,
    type: "movie",
    title,
    originalTitle: raw.original_title ? String(raw.original_title) : null,
    year: year && year > 1900 ? year : null,
    plot: raw.overview ? String(raw.overview) : null,
    rating: voteAvg > 0 ? Math.round(voteAvg * 10) / 10 : 0,
    votes,
    runtime: null,
    posterSmall: posterPath ? `${TMDB_IMAGE_BASE_URL}/w185${posterPath}` : null,
    posterMedium: posterPath ? `${TMDB_IMAGE_BASE_URL}/w500${posterPath}` : null,
    posterBig: posterPath ? `${TMDB_IMAGE_BASE_URL}/original${posterPath}` : null,
    genreIds: [],
  };
}

export async function fillCatalog(opts: FillOptions): Promise<FillSummary> {
  const startedAt = Date.now();
  const spec = opts.spec ?? {};
  const minVotesMovie = spec.minVotesMovie ?? 30;
  const minVotesTv = spec.minVotesTv ?? 20;
  const tmdb = new TmdbClient({
    apiKey: opts.apiKey,
    fetch: opts.fetch ?? fetch,
    baseUrl: opts.baseUrl,
    requestIntervalMs: opts.requestIntervalMs ?? 60,
  });

  const byKey = new Map<string, TmdbEntry>();
  const sources: string[] = [];
  const push = (e: TmdbEntry | null) => {
    if (e) byKey.set(`${e.type}:${e.tmdbId}`, e);
  };
  const report = (phase: FillProgress["phase"], processed = 0, added = 0, skipped = 0) => {
    opts.onProgress?.({
      phase,
      fetched: byKey.size,
      processed,
      added,
      skipped,
      total: 0,
      sources: [...sources],
    });
  };

  /* ---------- 1. Сбор ---------- */
  report("collect");

  // Годы: основа объёма. discover по популярности за год, глубина — yearPages.
  if (spec.years?.length) {
    for (const year of spec.years) {
      for (let p = 1; p <= (spec.yearPages ?? DEFAULT_FILL_PAGES.yearPages); p++) {
        for (const [kind, minVotes] of [
          ["movie", minVotesMovie],
          ["tv", minVotesTv],
        ] as const) {
          const from = kind === "movie" ? "primary_release_year" : "first_air_date_year";
          const data = await tmdb.get<{ results?: Array<Record<string, unknown>> }>(
            `/discover/${kind}?sort_by=popularity.desc&include_adult=false&${from}=${year}&vote_count.gte=${minVotes}&page=${p}`,
          );
          for (const raw of data?.results ?? []) push(mapEntry(raw, kind === "tv" ? "serial" : "movie", minVotes));
        }
        report("collect");
      }
    }
    sources.push(`years:${spec.years.length}`);
    report("collect");
  }

  // Жанровая матрица: хвост, который не попал в топ года.
  if (spec.genreMatrix) {
    for (const [from, to] of MATRIX_DECADES) {
      for (const genreId of MATRIX_GENRE_IDS) {
        for (const kind of ["movie", "tv"] as const) {
          const minVotes = kind === "movie" ? minVotesMovie : minVotesTv;
          const yearFrom = kind === "movie" ? "primary_release_date.gte" : "first_air_date.gte";
          const yearTo = kind === "movie" ? "primary_release_date.lte" : "first_air_date.lte";
          for (let p = 1; p <= (spec.genrePages ?? DEFAULT_FILL_PAGES.genrePages); p++) {
            const data = await tmdb.get<{ results?: Array<Record<string, unknown>> }>(
              `/discover/${kind}?sort_by=popularity.desc&include_adult=false&with_genres=${genreId}&${yearFrom}=${from}-01-01&${yearTo}=${to}-12-31&vote_count.gte=${minVotes}&page=${p}`,
            );
            for (const raw of data?.results ?? []) {
              push(mapEntry(raw, kind === "tv" ? "serial" : "movie", minVotes));
            }
          }
        }
      }
    }
    sources.push(`genres:${MATRIX_GENRE_IDS.length}`);
    report("collect");
  }

  // Списки: top_rated + trending + популярное.
  if (spec.lists) {
    for (let p = 1; p <= 5; p++) {
      for (const path of [
        `/movie/top_rated?page=${p}`,
        `/tv/top_rated?page=${p}`,
        `/trending/movie/week?page=${p}`,
        `/trending/tv/week?page=${p}`,
        `/movie/popular?page=${p}`,
        `/tv/popular?page=${p}`,
      ]) {
        const data = await tmdb.get<{ results?: Array<Record<string, unknown>> }>(path);
        const isTv = path.includes("/tv/") || path.includes("/trending/tv");
        for (const raw of data?.results ?? []) {
          push(mapEntry(raw, isTv ? "serial" : "movie", isTv ? minVotesTv : minVotesMovie));
        }
      }
      report("collect");
    }
    sources.push("lists");
  }

  // Страны: Корея, Япония, Индия и т.д. — заметно другой каталог.
  if (spec.countries?.length) {
    for (const country of spec.countries) {
      for (let p = 1; p <= (spec.countryPages ?? DEFAULT_FILL_PAGES.countryPages); p++) {
        for (const kind of ["movie", "tv"] as const) {
          const minVotes = kind === "movie" ? minVotesMovie : minVotesTv;
          const data = await tmdb.get<{ results?: Array<Record<string, unknown>> }>(
            `/discover/${kind}?sort_by=popularity.desc&include_adult=false&with_origin_country=${country}&vote_count.gte=${minVotes}&page=${p}`,
          );
          for (const raw of data?.results ?? []) {
            push(mapEntry(raw, kind === "tv" ? "serial" : "movie", minVotes));
          }
        }
      }
      report("collect");
    }
    sources.push(`countries:${spec.countries.length}`);
  }

  // Коллекции: целые франшизы. Сначала части (дёшево), детали — только новым.
  let collectionsInfo: FillSummary["collections"];
  if (spec.collections?.length) {
    const parts = new Map<number, TmdbEntry>();
    const found: string[] = [];
    const missing: string[] = [];

    for (const name of spec.collections) {
      const search = await tmdb.get<{ results?: Array<{ id?: number }> }>(
        `/search/collection?query=${encodeURIComponent(name)}`,
      );
      const collectionId = search?.results?.[0]?.id;
      if (!collectionId) {
        missing.push(name);
        continue;
      }
      found.push(name);
      const details = await tmdb.get<{ parts?: Array<Record<string, unknown>> }>(
        `/collection/${collectionId}`,
      );
      for (const part of details?.parts ?? []) {
        const e = mapCollectionPart(part);
        if (e) parts.set(e.tmdbId, e);
      }
      report("collect");
    }

    // Детали (жанры, runtime) — только для тех, кого ещё нет в каталоге.
    const existing = await filterExistingTmdbIds(opts.db, [...parts.keys()]);
    for (const part of parts.values()) {
      if (existing.has(part.tmdbId)) continue;
      const full = await tmdb.get<Record<string, unknown>>(`/movie/${part.tmdbId}`);
      if (full) push(mapDetail(full, 50) ?? part);
      else push(part);
    }
    for (const part of parts.values()) if (existing.has(part.tmdbId)) push(part);

    collectionsInfo = { found, missing };
    sources.push(`collections:${found.length}`);
    report("collect");
  }

  /* ---------- 2. Жанровая карта TMDb → локальные жанры ---------- */
  const localGenres = await listLocalGenres(opts.db);
  // TMDb отдаёт tv-жанры в нижнем регистре («драма»), movie — с заглавной,
  // локальный справочник — с заглавной. Сверка без учёта регистра, иначе
  // сериалы остаются без жанров.
  const byTitle = new Map(localGenres.map((g) => [g.title.toLowerCase(), g.id]));
  const byLower = (name: string): number | null => byTitle.get(name.toLowerCase()) ?? null;
  const tmdbToLocal = new Map<number, number | null>();
  for (const kind of ["movie", "tv"] as const) {
    const list = await tmdb.get<{ genres?: Array<{ id?: number; name?: string }> }>(
      `/genre/${kind}/list`,
    );
    for (const g of list?.genres ?? []) {
      if (typeof g.id !== "number") continue;
      const raw = g.name ?? "";
      const alias = GENRE_ALIASES[raw] ?? GENRE_ALIASES[raw.toLowerCase()] ?? raw;
      tmdbToLocal.set(g.id, byLower(alias) ?? byLower(raw));
    }
  }

  /* ---------- 3. Батчевая запись ---------- */
  const batch = opts.batchSize ?? 500;
  const entries = [...byKey.values()];
  let processed = 0;
  let added = 0;
  let skipped = 0;

  for (let i = 0; i < entries.length; i += batch) {
    const chunk = entries.slice(i, i + batch);
    const res = await insertCatalogBatch(opts.db, chunk, tmdbToLocal);
    processed += chunk.length;
    added += res.added;
    skipped += res.skipped;
    report("insert", processed, added, skipped);
  }

  /* ---------- 4. Аниме (AniLibria) ---------- */
  let animeSummary: AnimeImportSummary | undefined;
  if (spec.anime) {
    report("anime", processed, added, skipped);
    animeSummary = await importAnilibriaCatalog({
      db: opts.db,
      baseUrl: opts.anilibriaBaseUrl,
      fetch: opts.fetch,
      maxReleases: spec.animeLimit,
      onProgress: (p) => {
        opts.onProgress?.({
          phase: "anime",
          fetched: byKey.size,
          processed,
          added,
          skipped,
          total: 0,
          sources: [...sources],
          anime: { listed: p.listed, added: p.added, episodes: p.episodes },
        });
      },
    });
    sources.push(`anime:${animeSummary.added}`);
  }

  /* ---------- 5. Склейка дублей (похожие названия, близкие годы) ---------- */
  let dedupe: FillSummary["dedupe"];
  if (spec.dedupe !== false) {
    report("dedupe", processed, added, skipped);
    const merge = await mergeCatalogDuplicates(opts.db);
    dedupe = { candidates: merge.candidates, merged: merge.merged };
  }

  const total = await countCatalogItems(opts.db);
  const summary: FillSummary = {
    phase: "done",
    fetched: entries.length,
    processed,
    added,
    skipped,
    total,
    sources: [...sources],
    collections: collectionsInfo,
    dedupe,
    anime: animeSummary
      ? {
          listed: animeSummary.listed,
          added: animeSummary.added,
          episodes: animeSummary.episodes,
        }
      : undefined,
    durationMs: Date.now() - startedAt,
  };
  opts.onProgress?.({ ...summary, phase: "done" });
  return summary;
}

/** Годы fill по умолчанию: всё, что TMDb отдаёт с осмысленным числом голосов. */
export function defaultFillYears(from = 1950, to = new Date().getFullYear()): number[] {
  const years: number[] = [];
  for (let y = from; y <= to; y++) years.push(y);
  return years;
}

export { DEFAULT_COUNTRIES, GENRE_ALIASES, MATRIX_GENRE_IDS };
