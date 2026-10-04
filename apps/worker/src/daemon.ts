/**
 * Catalog Daemon: каталог сам следит за источниками, без ручных проходов.
 *
 * | задача             | частота  | что делает                                               |
 * | ------------------ | -------- | -------------------------------------------------------- |
 * | tmdb-changes       | 30 мин   | /movie|tv/changes → наши тайтлы: рейтинг, постер, бэкдроп,|
 * |                    |          | описание, статус; «вышли новые серии» → догидрация в API |
 * | tmdb-feeds         | 3 ч      | trending (день), now_playing, upcoming, on_the_air,      |
 * |                    |          | airing_today → новые тайтлы                              |
 * | anilibria-updates  | 15 мин   | /releases/latest → новые серии и релизы AniLibria        |
 * | metadata-gaps      | 1 ч      | дыры: нет бэкдропа/описания/длительности → детали TMDb   |
 * | images-new         | 1 ч      | свои AVIF/WebP + blurhash для новых тайтлов              |
 *
 * Сериалы без серий, склейку аниме, длинные сезоны и локализацию названий
 * догоняет gap-filler API (там TMDb-гидрация сезонов) — раз в 30 мин.
 *
 * BullMQ job schedulers в своей очереди `catalog-daemon`, concurrency 1:
 * задачи переживают рестарт, не дублируются и не ждут часовой fill в
 * очереди `catalog`. Курсоры и итог каждого прогона — в таблице sync_state.
 * Выключается CATALOG_DAEMON=0, отдельные задачи — DAEMON_SKIP=a,b.
 */
import {
  type Db,
  getSyncState,
  listItemsForTmdbRefresh,
  listItemsWithMetadataGaps,
  purgeRumEvents,
  recordSyncRun,
} from "@zal/db";
import {
  fetchTmdbChangedIds,
  fillCatalog,
  importAnilibriaUpdates,
  refreshItemsFromTmdb,
  TmdbClient,
} from "@zal/ingest";
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";

export const DAEMON_QUEUE = "catalog-daemon";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export type DaemonTaskId = "tmdb-changes" | "tmdb-feeds" | "anilibria-updates" | "metadata-gaps" | "images-new";

export interface DaemonSchedule {
  id: DaemonTaskId;
  everyMs: number;
}

export function daemonSchedules(env: NodeJS.ProcessEnv = process.env): DaemonSchedule[] {
  const skip = new Set((env.DAEMON_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const all: DaemonSchedule[] = [
    { id: "tmdb-changes", everyMs: 30 * MIN },
    { id: "tmdb-feeds", everyMs: 3 * HOUR },
    { id: "anilibria-updates", everyMs: 15 * MIN },
    { id: "metadata-gaps", everyMs: HOUR },
    { id: "images-new", everyMs: HOUR },
  ];
  return all.filter((s) => !skip.has(s.id));
}

export interface DaemonDeps {
  db: Db;
  tmdbApiKey: string;
  anilibriaBaseUrl?: string;
  /** Скрипт воркера дочерним процессом (images.ts) → код выхода. */
  runScript: (script: string, args: string[]) => Promise<number | null>;
  /** Подмена TMDb-клиента в тестах. */
  tmdb?: TmdbClient;
  now?: () => Date;
}

/** Сколько тайтлов обновлять за прогон tmdb-changes (на тип). */
const CHANGES_LIMIT = 400;

type Stats = Record<string, unknown>;

async function tmdbChanges(deps: DaemonDeps, tmdb: TmdbClient): Promise<{ stats: Stats; cursor?: string }> {
  const now = deps.now?.() ?? new Date();
  const state = await getSyncState(deps.db, "tmdb-changes");
  const since = state?.cursor ? new Date(state.cursor) : new Date(now.getTime() - 24 * HOUR);
  const stats: Stats = { since: since.toISOString() };
  let complete = true;
  for (const kind of ["movie", "tv"] as const) {
    const ids = await fetchTmdbChangedIds(tmdb, kind, since, { now });
    const rows = await listItemsForTmdbRefresh(deps.db, kind, ids, { staleHours: 6, limit: CHANGES_LIMIT });
    if (rows.length >= CHANGES_LIMIT) complete = false;
    const out = await refreshItemsFromTmdb(deps.db, tmdb, rows);
    stats[kind] = { changedAtTmdb: ids.length, ours: rows.length, ...out };
  }
  // Не успели всё — курсор не двигаем: следующий прогон доберёт остаток
  // (уже обновлённые отсеются по tmdb_refreshed_at).
  return { stats, cursor: complete ? now.toISOString() : (state?.cursor ?? since.toISOString()) };
}

async function tmdbFeeds(deps: DaemonDeps): Promise<{ stats: Stats }> {
  const res = await fillCatalog({
    db: deps.db,
    apiKey: deps.tmdbApiKey,
    spec: { feeds: true, feedPages: 3, dedupe: false },
  });
  return { stats: { fetched: res.fetched, added: res.added, skipped: res.skipped, ms: res.durationMs } };
}

async function anilibriaUpdates(deps: DaemonDeps): Promise<{ stats: Stats }> {
  const res = await importAnilibriaUpdates({ db: deps.db, baseUrl: deps.anilibriaBaseUrl, limit: 50 });
  return { stats: { listed: res.listed, added: res.added, updated: res.updated, episodes: res.episodes, ms: res.durationMs } };
}

async function metadataGaps(deps: DaemonDeps, tmdb: TmdbClient): Promise<{ stats: Stats }> {
  const rows = await listItemsWithMetadataGaps(deps.db, 300);
  const out = await refreshItemsFromTmdb(deps.db, tmdb, rows);
  const purged = await purgeRumEvents(deps.db, 30).catch(() => 0);
  return { stats: { ...out, rumPurged: purged } };
}

async function imagesNew(deps: DaemonDeps): Promise<{ stats: Stats }> {
  const code = await deps.runScript("images.ts", ["--limit=500"]);
  if (code !== 0) throw new Error(`images.ts exited with ${code}`);
  return { stats: { exit: code } };
}

/** Один прогон задачи с записью итога в sync_state. */
export async function runDaemonTask(deps: DaemonDeps, id: DaemonTaskId): Promise<Stats | null> {
  const tmdb = deps.tmdb ?? new TmdbClient({ apiKey: deps.tmdbApiKey, requestIntervalMs: 80 });
  const started = Date.now();
  try {
    const res: { stats: Stats; cursor?: string } =
      id === "tmdb-changes"
        ? await tmdbChanges(deps, tmdb)
        : id === "tmdb-feeds"
          ? await tmdbFeeds(deps)
          : id === "anilibria-updates"
            ? await anilibriaUpdates(deps)
            : id === "metadata-gaps"
              ? await metadataGaps(deps, tmdb)
              : await imagesNew(deps);
    const stats = { ...res.stats, ms: Date.now() - started };
    await recordSyncRun(deps.db, id, { ok: true, cursor: res.cursor, stats });
    console.log(`daemon: ${id} ${JSON.stringify(stats).slice(0, 400)}`);
    return stats;
  } catch (err) {
    const msg = String(err).slice(0, 500);
    console.warn(`daemon: ${id} failed: ${msg}`);
    await recordSyncRun(deps.db, id, { ok: false, error: msg }).catch(() => undefined);
    return null;
  }
}

export async function startCatalogDaemon(
  connection: ConnectionOptions,
  deps: DaemonDeps,
): Promise<() => Promise<void>> {
  const queue = new Queue(DAEMON_QUEUE, { connection });
  const schedules = daemonSchedules();
  const ids = new Set(schedules.map((s) => s.id));
  // Снятые через DAEMON_SKIP задачи убираем и из Redis — иначе крутились бы.
  for (const s of await queue.getJobSchedulers().catch(() => [])) {
    if (s.key && !ids.has(s.key as DaemonTaskId)) await queue.removeJobScheduler(s.key).catch(() => false);
  }
  for (const s of schedules) {
    await queue.upsertJobScheduler(
      s.id,
      { every: s.everyMs },
      { name: s.id, data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
    );
  }
  const worker = new Worker(
    DAEMON_QUEUE,
    async (job: Job) => runDaemonTask(deps, job.name as DaemonTaskId),
    { connection, concurrency: 1, lockDuration: 10 * MIN },
  );
  worker.on("error", (err) => {
    console.warn("daemon: worker error (non-fatal):", String(err).slice(0, 300));
  });
  console.log(`daemon: расписание ${schedules.map((s) => s.id).join(", ")}`);
  return async () => {
    await worker.close();
    await queue.close();
  };
}
