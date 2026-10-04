/**
 * Catalog Daemon, TMDb-часть: /changes (что поменялось у источника) и
 * точечное обновление наших тайтлов деталями TMDb — рейтинг, постер,
 * бэкдроп, описание, длительность, статус и «вышли новые серии».
 */
import { applyTmdbRefresh, type Db, type TmdbRefreshPatch, type TmdbRefreshRow } from "@zal/db";
import { TMDB_IMAGE_BASE_URL, type TmdbClient } from "./tmdb-client";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * id изменившихся у TMDb фильмов/сериалов с `since` (TMDb принимает окно
 * до 14 дней). Страниц бывает сотни — потолок maxPages, порядок не важен.
 */
export async function fetchTmdbChangedIds(
  tmdb: TmdbClient,
  kind: "movie" | "tv",
  since: Date,
  opts: { now?: Date; maxPages?: number } = {},
): Promise<number[]> {
  const now = opts.now ?? new Date();
  const floor = new Date(now.getTime() - 13 * 24 * 3600 * 1000);
  const start = since < floor ? floor : since;
  const ids = new Set<number>();
  const maxPages = opts.maxPages ?? 100;
  for (let page = 1; page <= maxPages; page++) {
    const data = await tmdb.get<{ results?: Array<{ id?: number; adult?: boolean }>; total_pages?: number }>(
      `/${kind}/changes?start_date=${ymd(start)}&end_date=${ymd(now)}&page=${page}`,
      { language: null },
    );
    for (const r of data?.results ?? []) if (typeof r.id === "number" && !r.adult) ids.add(r.id);
    const total = Number(data?.total_pages ?? 0);
    if (!data || page >= total) break;
  }
  return [...ids];
}

const img = (size: string, path: unknown) =>
  typeof path === "string" && path ? `${TMDB_IMAGE_BASE_URL}/${size}${path}` : null;

/** Детали TMDb → патч тайтла (ru-RU; пустые поля не трогают наше). */
export function detailsToPatch(
  row: Pick<TmdbRefreshRow, "tmdbType" | "externalSource" | "episodes">,
  d: Record<string, unknown>,
): TmdbRefreshPatch {
  const vote = typeof d.vote_average === "number" ? Math.round(d.vote_average * 10) / 10 : null;
  const votes = typeof d.vote_count === "number" ? d.vote_count : null;
  const runtimeMin =
    row.tmdbType === "movie"
      ? Number(d.runtime ?? 0)
      : Number((Array.isArray(d.episode_run_time) ? d.episode_run_time[0] : null) ?? 0);
  const status = typeof d.status === "string" ? d.status : "";
  const totalEpisodes = Number(d.number_of_episodes ?? 0);
  const poster = d.poster_path;
  return {
    tmdbRating: vote,
    tmdbVotes: votes,
    // Свой рейтинг у AniLibria-тайтлов и ручных — не перетираем TMDb-шным.
    rating: row.externalSource ? null : vote,
    plot: typeof d.overview === "string" && d.overview.trim() ? d.overview.trim() : null,
    posterSmall: img("w185", poster),
    posterMedium: img("w500", poster),
    posterBig: img("original", poster),
    backdropUrl: img("w1280", d.backdrop_path),
    runtimeAvg: runtimeMin > 0 ? runtimeMin * 60 : null,
    finished:
      row.tmdbType === "tv"
        ? status === "Ended" || status === "Canceled"
          ? true
          : status === "Returning Series" || status === "In Production"
            ? false
            : null
        : null,
    // Догидрация: у TMDb серий больше, чем у нас (и у нас они вообще есть —
    // пустые сериалы и так берёт gap-filler).
    episodesBehind: row.tmdbType === "tv" && row.episodes > 0 && totalEpisodes > row.episodes,
  };
}

export interface TmdbRefreshStats {
  checked: number;
  changed: number;
  images: number;
  behind: number;
  missing: number;
}

/** Обновить пачку тайтлов деталями TMDb (последовательно — клиент сам пейсит). */
export async function refreshItemsFromTmdb(
  db: Db,
  tmdb: TmdbClient,
  rows: TmdbRefreshRow[],
): Promise<TmdbRefreshStats> {
  const stats: TmdbRefreshStats = { checked: 0, changed: 0, images: 0, behind: 0, missing: 0 };
  for (const row of rows) {
    const d = await tmdb.get<Record<string, unknown>>(`/${row.tmdbType}/${row.tmdbId}`).catch(() => null);
    stats.checked++;
    if (!d || typeof d.id !== "number") {
      stats.missing++;
      // Всё равно ставим отметку, чтобы не долбить пропавший у TMDb id.
      await applyTmdbRefresh(db, row, {}).catch(() => undefined);
      continue;
    }
    const patch = detailsToPatch(row, d);
    const res = await applyTmdbRefresh(db, row, patch);
    if (res.changed) stats.changed++;
    if (res.imagesReset) stats.images++;
    if (patch.episodesBehind) stats.behind++;
  }
  return stats;
}
