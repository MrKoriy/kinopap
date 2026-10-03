/**
 * Каталожные запросы. Философия API 1.3 kino.pub: фильтры (тип/жанры/страны/
 * год-диапазон/актёр/режиссёр/буква), сортировка, cursor-пагинация, поиск,
 * similar, fresh/hot/popular, media-links.
 */

import {
  type CatalogFilters,
  type CursorPayload,
  decodeCursor,
  type ItemDetail,
  type ItemPage,
  type ItemSummary,
  type ItemType,
  type MediaLinks,
  makeCursor,
  type SortDir,
  type SortField,
  type SortSpec,
} from "@zal/api-client";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  audioTracks,
  countries,
  episodes,
  genres,
  itemCountries,
  itemGenres,
  itemPeople,
  items,
  media,
  mediaFiles,
  people,
  seasons,
  subtitles,
} from "../schema/index";

type ItemRow = typeof items.$inferSelect;

const SERIAL_LIKE: readonly ItemType[] = ["serial", "docuserial", "tvshow"];

const SORT_COLS: Record<SortField, (typeof items)["id"] | (typeof items)["year"] | (typeof items)["title"] | (typeof items)["rating"] | (typeof items)["views"] | (typeof items)["createdAt"] | (typeof items)["updatedAt"]> = {
  id: items.id,
  year: items.year,
  title: items.title,
  rating: items.rating,
  views: items.views,
  created: items.createdAt,
  updated: items.updatedAt,
};

const itemColumns = {
  id: items.id,
  type: items.type,
  subtype: items.subtype,
  title: items.title,
  originalTitle: items.originalTitle,
  year: items.year,
  plot: items.plot,
  runtimeAvg: items.runtimeAvg,
  runtimeTotal: items.runtimeTotal,
  langs: items.langs,
  hasAc3: items.hasAc3,
  quality: items.quality,
  imdbId: items.imdbId,
  imdbRating: items.imdbRating,
  imdbVotes: items.imdbVotes,
  kinopoiskId: items.kinopoiskId,
  kinopoiskRating: items.kinopoiskRating,
  kinopoiskVotes: items.kinopoiskVotes,
  tmdbId: items.tmdbId,
  tmdbType: items.tmdbType,
  tmdbRating: items.tmdbRating,
  tmdbVotes: items.tmdbVotes,
  externalSource: items.externalSource,
  externalId: items.externalId,
  rating: items.rating,
  votesPositive: items.votesPositive,
  votesNegative: items.votesNegative,
  views: items.views,
  finished: items.finished,
  advert: items.advert,
  posterSmall: items.posterSmall,
  posterMedium: items.posterMedium,
  posterBig: items.posterBig,
  trailerId: items.trailerId,
  trailerUrl: items.trailerUrl,
  trailerCheckedAt: items.trailerCheckedAt,
  titleLocalizedAt: items.titleLocalizedAt,
  noSourceCount: items.noSourceCount,
  noSourceAt: items.noSourceAt,
  tmdbMatchedAt: items.tmdbMatchedAt,
  seasonLayout: items.seasonLayout,
  createdAt: items.createdAt,
  updatedAt: items.updatedAt,
};

/* ---------- Сборка ItemSummary ---------- */

interface ItemRefs {
  genres: { id: number; title: string }[];
  countries: { id: number; title: string }[];
  cast: string[];
  director: string[];
}

async function attachRefs(db: Db, ids: number[]): Promise<Map<number, ItemRefs>> {
  const refs = new Map<number, ItemRefs>();
  for (const id of ids) {
    refs.set(id, { genres: [], countries: [], cast: [], director: [] });
  }
  if (!ids.length) return refs;

  // Три независимых выборки — параллельно: последовательно это три RT
  // к БД на каждую страницу каталога.
  const [genreRows, countryRows, peopleRows] = await Promise.all([
    db
      .select({ itemId: itemGenres.itemId, id: genres.id, title: genres.title })
      .from(itemGenres)
      .innerJoin(genres, eq(itemGenres.genreId, genres.id))
      .where(inArray(itemGenres.itemId, ids)),
    db
      .select({ itemId: itemCountries.itemId, id: countries.id, title: countries.title })
      .from(itemCountries)
      .innerJoin(countries, eq(itemCountries.countryId, countries.id))
      .where(inArray(itemCountries.itemId, ids)),
    db
      .select({ itemId: itemPeople.itemId, name: people.name, role: itemPeople.role })
      .from(itemPeople)
      .innerJoin(people, eq(itemPeople.personId, people.id))
      .where(inArray(itemPeople.itemId, ids)),
  ]);
  for (const g of genreRows) refs.get(g.itemId)?.genres.push({ id: g.id, title: g.title });
  for (const c of countryRows) refs.get(c.itemId)?.countries.push({ id: c.id, title: c.title });
  for (const p of peopleRows) {
    const ref = refs.get(p.itemId);
    if (!ref) continue;
    if (p.role === "actor") ref.cast.push(p.name);
    if (p.role === "director") ref.director.push(p.name);
  }
  return refs;
}

function mapItem(row: ItemRow, refs: ItemRefs): ItemSummary {
  return {
    id: row.id,
    type: row.type,
    subtype: row.subtype,
    title: row.title,
    originalTitle: row.originalTitle,
    year: row.year,
    plot: row.plot,
    cast: refs.cast,
    director: refs.director,
    duration: { average: row.runtimeAvg, total: row.runtimeTotal },
    langs: row.langs,
    ac3: row.hasAc3,
    quality: row.quality,
    genres: refs.genres,
    countries: refs.countries,
    imdb: { id: row.imdbId, rating: row.imdbRating, votes: row.imdbVotes },
    kinopoisk: {
      id: row.kinopoiskId,
      rating: row.kinopoiskRating,
      votes: row.kinopoiskVotes,
    },
    tmdb: { id: row.tmdbId, rating: row.tmdbRating, votes: row.tmdbVotes },
    rating: row.rating,
    votes: {
      positive: row.votesPositive,
      negative: row.votesNegative,
      total: row.votesPositive + row.votesNegative,
    },
    views: row.views,
    finished: row.finished,
    advert: row.advert,
    posters: {
      small: row.posterSmall,
      medium: row.posterMedium,
      big: row.posterBig,
    },
    trailer: { id: row.trailerId, url: row.trailerUrl },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function toPage(
  db: Db,
  rows: ItemRow[],
  sort: SortSpec,
  limit: number,
): Promise<ItemPage> {
  const overflow = rows.length > limit;
  const pageRows = overflow ? rows.slice(0, limit) : rows;
  const refs = await attachRefs(
    db,
    pageRows.map((r) => r.id),
  );
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((r) => mapItem(r, refs.get(r.id)!)),
    nextCursor:
      overflow && last
        ? makeCursor(sort, sortValue(last, sort.field), last.id)
        : null,
  };
}

function sortValue(row: ItemRow, field: SortField): string | number | null {
  switch (field) {
    case "created":
      return row.createdAt.toISOString();
    case "updated":
      return row.updatedAt.toISOString();
    case "year":
      return row.year;
    case "title":
      return row.title;
    case "rating":
      return row.rating;
    case "views":
      return row.views;
    case "id":
      return row.id;
  }
}

/* ---------- Фильтры ---------- */

function buildFilters(f: CatalogFilters): SQL[] {
  const conds: SQL[] = [];
  // Тайтлы без единой раздачи (два пустых резолва подряд за неделю) не
  // показываем в лентах и каталоге — поиск и прямая ссылка их находят.
  conds.push(
    sql`not (${items.noSourceCount} >= 2 and ${items.noSourceAt} > now() - interval '7 days')`,
  );
  if (f.type) conds.push(eq(items.type, f.type));
  if (f.title) conds.push(sql`${items.title} ilike ${`${f.title}%`}`);
  if (f.yearFrom != null) conds.push(sql`${items.year} >= ${f.yearFrom}`);
  if (f.yearTo != null) conds.push(sql`${items.year} <= ${f.yearTo}`);
  if (f.ratingMin != null) {
    conds.push(
      sql`coalesce(nullif(${items.rating}, 0), ${items.imdbRating}, ${items.tmdbRating}, ${items.kinopoiskRating}, 0) >= ${f.ratingMin}`,
    );
  }
  if (f.letter) {
    const pat = `${f.letter}%`;
    conds.push(
      or(
        sql`left(${items.title}, 1) ilike ${pat}`,
        sql`left(${items.originalTitle}, 1) ilike ${pat}`,
      )!,
    );
  }
  if (f.genreIds?.length) {
    const list = sql.join(f.genreIds.map((id) => sql`${id}`), sql`, `);
    conds.push(
      sql`${items.id} in (select item_id from item_genres where genre_id in (${list}))`,
    );
  }
  if (f.countryIds?.length) {
    const list = sql.join(f.countryIds.map((id) => sql`${id}`), sql`, `);
    conds.push(
      sql`${items.id} in (select item_id from item_countries where country_id in (${list}))`,
    );
  }
  if (f.actor) {
    conds.push(personFilter("actor", f.actor));
  }
  if (f.director) {
    conds.push(personFilter("director", f.director));
  }
  return conds;
}

function personFilter(role: "actor" | "director", name: string): SQL {
  return sql`${items.id} in (
    select ip.item_id from item_people ip
    join people p on p.id = ip.person_id
    where ip.role = ${role} and p.name ilike ${`%${name}%`}
  )`;
}

function cursorCond(cursor: CursorPayload): SQL {
  const col = SORT_COLS[cursor.s];
  const value =
    (cursor.s === "created" || cursor.s === "updated") && typeof cursor.v === "string"
      ? new Date(cursor.v)
      : cursor.v;
  // NULLS LAST: кортеж (NULL, id) не сравнивается корректно — ветвим по направлению.
  if (value == null) {
    return cursor.d === "desc"
      ? sql`${col} is null and ${items.id} < ${cursor.id}`
      : sql`${col} is null and ${items.id} > ${cursor.id}`;
  }
  if (cursor.d === "desc") {
    // desc nulls last: после не-null идут меньшие значения, затем NULL-блок.
    return sql`(${col} < ${value} or ${col} is null or (${col} = ${value} and ${items.id} < ${cursor.id}))`;
  }
  // asc nulls last: после не-null — большие значения, затем NULL-блок.
  return sql`(${col} > ${value} or ${col} is null or (${col} = ${value} and ${items.id} > ${cursor.id}))`;
}

function orderBy(sort: SortSpec) {
  const col = SORT_COLS[sort.field];
  // DESC в Postgres по умолчанию NULLS FIRST: тайтлы без года вылезали
  // первыми в «Свежем». Явно уводим NULL-ключи в конец.
  return sort.dir === "desc"
    ? [sql`${col} desc nulls last`, desc(items.id)]
    : [sql`${col} asc nulls last`, sql`${items.id} asc`];
}

/* ---------- Публичные запросы ---------- */

export async function listItems(db: Db, f: CatalogFilters): Promise<ItemPage> {
  const conds = buildFilters(f);
  const cursor = f.cursor ? decodeCursor(f.cursor) : null;
  // Курсор от другой сортировки игнорируем — иначе страницы поедут.
  if (cursor && cursor.s === f.sort.field && cursor.d === f.sort.dir) {
    conds.push(cursorCond(cursor));
  }
  const rows = await db
    .select(itemColumns)
    .from(items)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...orderBy(f.sort))
    .limit(f.limit + 1);
  return toPage(db, rows, f.sort, f.limit);
}

/**
 * Карточки (summary) по списку id: батч для лент, где id уже известны
 * («продолжить смотреть», подборки) — один запрос вместо N getItem.
 * Порядок результата — порядок входных ids; дубли схлопываются;
 * отсутствующие id молча пропускаются.
 */
export async function getItemsByIds(db: Db, ids: number[]): Promise<ItemSummary[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db
    .select(itemColumns)
    .from(items)
    .where(inArray(items.id, unique));
  const refs = await attachRefs(
    db,
    rows.map((r) => r.id),
  );
  const byId = new Map(rows.map((r) => [r.id, mapItem(r, refs.get(r.id)!)]));
  return unique.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

export interface SearchOptions {
  q: string;
  type?: ItemType;
  field?: "title" | "director" | "cast";
  limit: number;
}

export async function searchItems(db: Db, opts: SearchOptions): Promise<ItemPage> {
  const pattern = `%${opts.q}%`;
  const conds: SQL[] = [];

  if (!opts.field || opts.field === "title") {
    conds.push(
      or(
        sql`similarity(${items.title}, ${opts.q}) > 0.1`,
        sql`${items.title} ilike ${pattern}`,
        sql`${items.originalTitle} ilike ${pattern}`,
      )!,
    );
  }
  if (!opts.field || opts.field === "director") {
    conds.push(personFilter("director", opts.q));
  }
  if (!opts.field || opts.field === "cast") {
    conds.push(personFilter("actor", opts.q));
  }

  // type — отдельным AND, а не в or(): в or() он расширяет выдачу
  // (q + type возвращал и другой тип) и не даёт задействовать
  // композитные индексы (type, ...).
  const textCond = or(...conds);
  const where = textCond && opts.type ? and(textCond, eq(items.type, opts.type)) : textCond;

  const rows = await db
    .select(itemColumns)
    .from(items)
    .where(where)
    .orderBy(
      desc(
        sql`greatest(
          coalesce(similarity(${items.title}, ${opts.q}), 0),
          coalesce(similarity(${items.originalTitle}, ${opts.q}), 0)
        )`,
      ),
    )
    .limit(opts.limit);

  const refs = await attachRefs(
    db,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => mapItem(r, refs.get(r.id)!)), nextCursor: null };
}

export async function getItem(db: Db, id: number): Promise<ItemDetail | null> {
  const rows = await db
    .select(itemColumns)
    .from(items)
    .where(eq(items.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // Раунд-трейпы: refs нужны всегда; для сериалов сезоны и эпизоды
  // независимы (эпизоды — подзапросом по сезонам тайтла, а не списком id
  // из предыдущей выборки), для фильмов media известен заранее. Один
  // промис на ветку — сериалам media не нужен, фильмам — сезоны.
  const serialLike = SERIAL_LIKE.includes(row.type) || row.type === "anime";
  const [refs, seasonRows, eps, movieMediaRows] = await Promise.all([
    attachRefs(db, [id]),
    serialLike
      ? db.select().from(seasons).where(eq(seasons.itemId, id)).orderBy(seasons.number)
      : Promise.resolve([]),
    serialLike
      ? db
          .select({
            id: episodes.id,
            seasonId: episodes.seasonId,
            number: episodes.number,
            title: episodes.title,
            thumbnailUrl: episodes.thumbnailUrl,
            runtime: episodes.runtime,
            mediaId: media.id,
          })
          .from(episodes)
          .leftJoin(media, eq(media.episodeId, episodes.id))
          .where(
            inArray(
              episodes.seasonId,
              db.select({ id: seasons.id }).from(seasons).where(eq(seasons.itemId, id)),
            ),
          )
          .orderBy(episodes.number)
      : Promise.resolve([]),
    serialLike
      ? null
      : db.select().from(media).where(eq(media.itemId, id)).orderBy(media.partNumber),
  ]);
  const base = mapItem(row, refs.get(id)!);

  // Аниме без сезонов — это фильм: навигация по media-частям, не по сериям.
  if (serialLike && (seasonRows.length > 0 || SERIAL_LIKE.includes(row.type))) {
    // Длительность сериала выводим из эпизодов: это самый точный источник
    // (гидрация TMDb и AniLibria пишут реальные минуты). Раньше здесь
    // оставалось то, что записал сид/ингест, — у сид-тайтлов это был фолбэк
    // 7200, и весь топ каталога показывал «2:00:00».
    const epRuntimes = eps.map((e) => e.runtime).filter((r) => r > 0);
    return {
      ...base,
      duration:
        epRuntimes.length > 0
          ? {
              average: Math.round(epRuntimes.reduce((n, r) => n + r, 0) / epRuntimes.length),
              total: epRuntimes.reduce((n, r) => n + r, 0),
            }
          : base.duration,
      seasons: seasonRows.map((s) => ({
        id: s.id,
        number: s.number,
        title: s.title,
        episodes: eps
          .filter((e) => e.seasonId === s.id)
          .map((e) => ({
            id: e.id,
            number: e.number,
            title: e.title,
            thumbnailUrl: e.thumbnailUrl,
            runtime: e.runtime,
            mediaId: e.mediaId,
          })),
      })),
      media: null,
    };
  }

  // Фильм или аниме без сезонов: media-части. Аниме до этой ветки доходит
  // только с пустыми seasonRows — media для него тянули не в parallel выше.
  const mediaRows = serialLike
    ? await db
        .select()
        .from(media)
        .where(eq(media.itemId, id))
        .orderBy(media.partNumber)
    : movieMediaRows!;
  // У discovery-фильмов runtime_avg исторически не записывался, а длительность
  // лежит в media.runtime — выводим её на чтении, пока бэкфилл не перенесёт.
  const partRuntimes = mediaRows.map((m) => m.runtime).filter((r) => r > 0);
  return {
    ...base,
    duration:
      row.runtimeAvg == null && partRuntimes.length > 0
        ? {
            average: Math.round(partRuntimes.reduce((n, r) => n + r, 0) / partRuntimes.length),
            total: row.runtimeTotal ?? partRuntimes.reduce((n, r) => n + r, 0),
          }
        : base.duration,
    seasons: null,
    media: mediaRows.map((m) => ({
      id: m.id,
      partNumber: m.partNumber,
      title: m.title,
      thumbnailUrl: m.thumbnailUrl,
      runtime: m.runtime,
    })),
  };
}

export async function similarItems(
  db: Db,
  itemId: number,
  limit = 10,
): Promise<ItemPage> {
  const targetGenres = await db
    .select({ genreId: itemGenres.genreId })
    .from(itemGenres)
    .where(eq(itemGenres.itemId, itemId));
  if (!targetGenres.length) return { items: [], nextCursor: null };

  const list = sql.join(
    targetGenres.map((g) => sql`${g.genreId}`),
    sql`, `,
  );
  const rows = await db
    .select(itemColumns)
    .from(items)
    .where(
      and(
        sql`${items.id} <> ${itemId}`,
        sql`exists (
          select 1 from item_genres g
          where g.item_id = ${items.id} and g.genre_id in (${list})
        )`,
      ),
    )
    .orderBy(desc(items.rating), desc(items.views))
    .limit(limit);

  const refs = await attachRefs(
    db,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => mapItem(r, refs.get(r.id)!)), nextCursor: null };
}

export type ShortcutKind = "fresh" | "hot" | "popular";

/** fresh — новые, hot — самые просматриваемые, popular — по рейтингу. */
export async function shortcutItems(
  db: Db,
  kind: ShortcutKind,
  f: { type?: ItemType; limit: number; cursor?: string | null },
): Promise<ItemPage> {
  const sort: SortSpec = {
    field: kind === "fresh" ? "year" : kind === "hot" ? "views" : "rating",
    dir: "desc",
  };
  // fresh: без года «свежесть» не определить — такие тайтлы не показываем
  // (year >= 1900 отсекает NULL: NULL-сравнение в SQL ложно).
  const yearFrom = kind === "fresh" ? 1900 : undefined;
  return listItems(db, {
    type: f.type,
    sort,
    limit: f.limit,
    cursor: f.cursor ?? null,
    yearFrom,
  });
}

/* ---------- Media links ---------- */

function mediaUrl(baseUrl: string, key: string | null): string | null {
  if (!key) return null;
  return `${baseUrl.replace(/\/$/, "")}/${key.replace(/^\//, "")}`;
}

export async function mediaLinks(
  db: Db,
  itemId: number,
  mediaId: number,
  baseUrl: string,
): Promise<MediaLinks | null> {
  const mediaRows = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
  const m = mediaRows[0];
  if (!m || m.itemId !== itemId) return null;

  // Три независимые выборки — параллельно.
  const [files, audios, subs] = await Promise.all([
    db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.mediaId, mediaId))
      .orderBy(desc(mediaFiles.height)),
    db
      .select()
      .from(audioTracks)
      .where(eq(audioTracks.mediaId, mediaId))
      .orderBy(audioTracks.trackIndex),
    db
      .select()
      .from(subtitles)
      .where(eq(subtitles.mediaId, mediaId))
      .orderBy(subtitles.lang),
  ]);

  return {
    mediaId: m.id,
    itemId: m.itemId,
    posterUrl: mediaUrl(baseUrl, m.posterKey),
    intro:
      m.introStartSeconds != null && m.introEndSeconds != null
        ? {
            startSeconds: m.introStartSeconds,
            endSeconds: m.introEndSeconds,
          }
        : null,
    sprites:
      m.spriteKey && m.spriteMeta
        ? {
            url: mediaUrl(baseUrl, m.spriteKey) ?? "",
            intervalSeconds: m.spriteMeta.intervalSeconds,
            tileWidth: m.spriteMeta.tileWidth,
            tileHeight: m.spriteMeta.tileHeight,
            columns: m.spriteMeta.columns,
            rows: m.spriteMeta.rows,
            count: m.spriteMeta.count,
          }
        : null,
    files: files.map((f) => ({
      quality: f.quality,
      qualityId: f.qualityId,
      width: f.width,
      height: f.height,
      codec: f.codec,
      bitrate: f.bitrate,
      sizeBytes: f.sizeBytes,
      urls: {
        http: mediaUrl(baseUrl, f.fileKey) ?? "",
        hls: mediaUrl(baseUrl, f.hlsKey),
      },
    })),
    audios: audios.map((a) => ({
      id: a.id,
      index: a.trackIndex,
      codec: a.codec,
      channels: a.channels,
      lang: a.lang,
      type: a.dubType,
      author: { title: a.authorTitle, shortTitle: a.authorShortTitle },
      url: mediaUrl(baseUrl, a.fileKey),
      masterUrl: mediaUrl(baseUrl, a.masterKey),
    })),
    subtitles: subs.map((s) => ({
      id: s.id,
      lang: s.lang,
      shiftMs: s.shiftMs,
      embed: s.embed,
      title: s.title,
      url: mediaUrl(baseUrl, s.fileKey),
    })),
  };
}

/* ---------- Мета ---------- */

export async function listGenres(
  db: Db,
  type?: string,
): Promise<{ id: number; title: string; type: string }[]> {
  return type
    ? db.select().from(genres).where(eq(genres.type, type as never)).orderBy(genres.title)
    : db.select().from(genres).orderBy(genres.title);
}

export async function listCountries(db: Db) {
  return db.select().from(countries).orderBy(countries.title);
}

/* ---------- Бэкфилл трейлеров ---------- */

export interface TrailerBackfillRow {
  id: number;
  type: ItemType;
  title: string;
  year: number | null;
  tmdbId: number;
}

/** Порог ретрая «трейлера нет»: ролики появляются после релиза. */
const TRAILER_RETRY_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Очередь бэкфилла трейлеров: тайтлы с TMDb id, но без ссылки на ролик.
 * Курсор — по id (afterId), чтобы обход не сдвигался при записи в те же
 * строки: запись трейлера выводит строку из выборки, и offset «съедал» бы
 * следующий тайтл.
 *
 * Негативный кэш: тайтл, у которого TMDb подтвердил «трейлера нет»
 * (trailer_checked_at свежее 90 дней), из выборки выпадает — раньше такие
 * висели в ней навсегда и каждый прогон переспрашивал TMDb о них же.
 */
export async function listItemsMissingTrailer(
  db: Db,
  opts: { limit?: number; afterId?: number } = {},
): Promise<TrailerBackfillRow[]> {
  const rows = await db
    .select({
      id: items.id,
      type: items.type,
      title: items.title,
      year: items.year,
      tmdbId: items.tmdbId,
    })
    .from(items)
    .where(
      and(
        isNotNull(items.tmdbId),
        isNull(items.trailerUrl),
        or(
          isNull(items.trailerCheckedAt),
          lt(items.trailerCheckedAt, new Date(Date.now() - TRAILER_RETRY_MS)),
        ),
        gt(items.id, opts.afterId ?? 0),
      ),
    )
    .orderBy(items.id)
    .limit(opts.limit ?? 200);
  return rows as TrailerBackfillRow[];
}

/** Сколько тайтлов ещё ждут трейлер — прогресс бэкфилла. */
export async function countItemsMissingTrailer(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(
      and(
        isNotNull(items.tmdbId),
        isNull(items.trailerUrl),
        or(
          isNull(items.trailerCheckedAt),
          lt(items.trailerCheckedAt, new Date(Date.now() - TRAILER_RETRY_MS)),
        ),
      ),
    );
  return rows[0]?.n ?? 0;
}

/** Точечная запись трейлера (бэкфилл, ленивая гидратация). */
export async function setItemTrailer(
  db: Db,
  itemId: number,
  trailer: { id: string | null; url: string | null },
): Promise<void> {
  await db
    .update(items)
    .set({
      trailerId: trailer.id,
      trailerUrl: trailer.url,
      trailerCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(items.id, itemId));
}

/** Негативный кэш: TMDb сказал «трейлера нет» — не спрашивать 90 дней. */
export async function markTrailerChecked(db: Db, itemId: number): Promise<void> {
  await db
    .update(items)
    .set({ trailerCheckedAt: new Date() })
    .where(eq(items.id, itemId));
}

/* ---------- Бэкфилл длительности ---------- */

/** Маркер сида: до фикса tmdbMeta всем тайтлам писали fallback 7200. */
export const SEED_RUNTIME_FALLBACK = 7200;

export interface RuntimeBackfillRow {
  id: number;
  type: string;
  title: string;
  tmdbId: number;
  tmdbType: string | null;
}

/**
 * Тайтлы для бэкфилла длительности из TMDb: runtime_avg пуст или равен
 * сид-фолбэку 7200, а tmdb_id есть (у AniLibria-тайтлов его нет — их
 * длительность выводится из эпизодов SQL-фазой).
 */
export async function listItemsMissingRuntime(
  db: Db,
  opts: { limit?: number; afterId?: number } = {},
): Promise<RuntimeBackfillRow[]> {
  const rows = await db
    .select({
      id: items.id,
      type: items.type,
      title: items.title,
      tmdbId: items.tmdbId,
      tmdbType: items.tmdbType,
    })
    .from(items)
    .where(
      and(
        isNotNull(items.tmdbId),
        or(isNull(items.runtimeAvg), eq(items.runtimeAvg, SEED_RUNTIME_FALLBACK)),
        gt(items.id, opts.afterId ?? 0),
      ),
    )
    .orderBy(items.id)
    .limit(opts.limit ?? 200);
  return rows as RuntimeBackfillRow[];
}

/** Сколько тайтлов ещё ждут длительность — прогресс бэкфилла. */
export async function countItemsMissingRuntime(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(
      and(
        isNotNull(items.tmdbId),
        or(isNull(items.runtimeAvg), eq(items.runtimeAvg, SEED_RUNTIME_FALLBACK)),
      ),
    );
  return rows[0]?.n ?? 0;
}

/** Точечная запись длительности (бэкфилл TMDb-фазы). */
export async function setItemRuntime(db: Db, itemId: number, runtimeAvg: number): Promise<void> {
  await db
    .update(items)
    .set({ runtimeAvg, updatedAt: new Date() })
    .where(eq(items.id, itemId));
}

/**
 * SQL-фаза бэкфилла: длительность из собственных данных, без внешних API.
 *
 * Сериалы/аниме — среднее и сумма по эпизодам (гидрация TMDb и AniLibria пишут
 * реальные минуты). Фильмы — среднее по media-частям, только там, где
 * runtime_avg пуст (записанное TMDb/ингестом не перезатираем). Возвращает,
 * сколько строк обновила каждая фаза.
 */
export async function backfillRuntimeFromLocalData(
  db: Db,
): Promise<{ serials: number; movies: number }> {
  const serials = await db.execute(sql`
    update ${items} as i set
      runtime_avg = s.avg_runtime,
      runtime_total = s.total_runtime,
      updated_at = now()
    from (
      select se.item_id,
             round(avg(ep.runtime))::int as avg_runtime,
             sum(ep.runtime)::int as total_runtime
      from ${episodes} ep
      join ${seasons} se on se.id = ep.season_id
      where ep.runtime > 0
      group by se.item_id
    ) as s
    where i.id = s.item_id
      and (i.runtime_avg is distinct from s.avg_runtime
           or i.runtime_total is distinct from s.total_runtime)
  `);

  const movies = await db.execute(sql`
    update ${items} as i set
      runtime_avg = s.avg_runtime,
      updated_at = now()
    from (
      select m.item_id, round(avg(m.runtime))::int as avg_runtime
      from ${media} m
      where m.runtime > 0
      group by m.item_id
    ) as s
    where i.id = s.item_id
      and i.runtime_avg is null
  `);

  const count = (r: unknown): number => {
    const row = (r as { rowCount?: number; changes?: number } | null) ?? null;
    return row?.rowCount ?? row?.changes ?? 0;
  };
  return { serials: count(serials), movies: count(movies) };
}

export type { SortDir };

/** Итог резолва первой серии/фильма: пусто — +1 к счётчику, нашлось — сброс. */
export async function markSourceAvailability(db: Db, itemId: number, found: boolean): Promise<void> {
  if (found) {
    await db.execute(sql`update items set no_source_count = 0, no_source_at = null
      where id = ${itemId} and no_source_count > 0`);
  } else {
    await db.execute(sql`update items set no_source_count = no_source_count + 1, no_source_at = now()
      where id = ${itemId}`);
  }
}
