import {
  type IntroMarker,
  ITEM_TYPE_TITLES,
  ITEM_TYPES,
  type ItemPage,
  itemsSummaryQuerySchema,
  type MediaFile,
  type MediaTracks,
  parseCatalogQuery,
  prefetchRequestSchema,
  searchRawQuerySchema,
  shortcutQuerySchema,
  streamHashFromUrl,
  streamReportRequestSchema,
  type WarmRelease,
} from "@zal/api-client";
import {
  bannedStreamHashes,
  type Db,
  deleteSource,
  episodes,
  getItem,
  getItemsByIds,
  getSource,
  getStreamSources,
  isSourceFresh,
  items,
  listCountries,
  listGenres,
  listItems,
  markSourceAvailability,
  media,
  mediaLinks,
  patchSource,
  prewarmCandidates,
  recordStreamSources,
  refreshItemPlayable,
  reportStreamSource,
  resolveItemRedirect,
  type StreamResolveTarget,
  type StreamSourceCandidate,
  saveSource,
  searchItems,
  seasons,
  shortcutItems,
  similarItems,
  streamResolveTarget,
  usableStreamSources,
} from "@zal/db";
import { type StreamCandidate, StreamResolver } from "@zal/ingest";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Config } from "../config";
import { ensureItemCredits } from "../lib/credits";
import { notFound, parseOrThrow } from "../lib/http";
import { idParamsSchema } from "../lib/params";
import { redisSearchCache } from "../lib/redis-cache";
import { regroupLongSeasons } from "../lib/season-layout";
import { signStreamLinks } from "../lib/stream-links";
import { hydrateSerialSeasons, tmdbLookup } from "../lib/tmdb";
import { optionalUser } from "../plugins/auth";

const mediaLinksQuerySchema = z.object({ mid: z.coerce.number().int().positive() });
const genresQuerySchema = z.object({ type: z.string().optional() });

/** TTL кэша on-the-fly резолва стримов: повторное открытие watch-страницы
 * не должно снова ходить в rutor (до ~12с латентности). */
const RESOLVE_CACHE_TTL_MS = 30 * 60 * 1000;
/** Прогрев считает пару свежей, если её резолвили позже этого срока. */
const PREWARM_FRESH_MS = 20 * 60 * 60 * 1000;
/** Бюджет ожидания ленивой гидрации сезонов в request path. */
const HYDRATE_AWAIT_BUDGET_MS = 2_500;

/** Одна запись кэша резолва (L1 — память процесса). */
interface ResolveCacheEntry {
  at: number;
  files: MediaFile[];
  audios: MediaTracks["audios"];
  intro: IntroMarker | null;
  /** Прогретый релиз; null — прогрев ещё едет или провалился. */
  warm: WarmRelease | null;
}


export async function catalogRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config; redis?: Redis | null },
): Promise<void> {
  const { db, config } = deps;
  /** TTL кэша в БД: раздача живёт днями, а холодный резолв стоит 1–10 с.
   * Раньше 6 ч — при малом трафике кэш вымирал к каждому вечеру. */
  const RESOLVE_DB_TTL_MS = config.resolveSourceTtlMs;

  // Кэш zero-storage резолва: item/media → ссылки. L1 — память процесса,
  // L2 — таблица media_sources в БД (переживает рестарт/деплой).
  const resolveCache = new Map<string, ResolveCacheEntry>();
  /** Одновременные пробы дорожек на одну пару не должны дублироваться. */
  const trackProbes = new Map<string, Promise<MediaTracks>>();
  /** Параллельные холодные резолвы одной пары (item, media) — один прогон. */
  const linkResolves = new Map<string, Promise<ResolveCacheEntry | null>>();
  /** Потолок L1: без него долгоживущий процесс копит запись на каждую
   * пару до рестарта (медленная утечка под PM2). Обрезка — протухшие +
   * старейшие (Map хранит порядок вставки). */
  const RESOLVE_CACHE_MAX = 500;

  const makeEntry = (
    files: MediaFile[],
    audios: MediaTracks["audios"],
    intro: IntroMarker | null,
    warm: WarmRelease | null,
  ): ResolveCacheEntry => ({ at: Date.now(), files, audios, intro, warm });

  function cacheResolveEntry(key: string, entry: ResolveCacheEntry): void {
    resolveCache.set(key, entry);
    if (resolveCache.size <= RESOLVE_CACHE_MAX) return;
    const now = Date.now();
    for (const [k, v] of resolveCache) {
      if (now - v.at >= RESOLVE_CACHE_TTL_MS) resolveCache.delete(k);
    }
    while (resolveCache.size > RESOLVE_CACHE_MAX) {
      const oldest = resolveCache.keys().next().value;
      if (oldest === undefined) break;
      resolveCache.delete(oldest);
    }
  }

  function applyCached(links: {
    files: MediaFile[];
    audios: MediaTracks["audios"];
    intro: IntroMarker | null;
  }, entry: ResolveCacheEntry): void {
    links.files = entry.files;
    links.audios = entry.audios;
    // Интро релиза (AniLibria) точнее; без него остаётся найденное
    // детектором по звуку (media.intro_*), а не затирается null из кэша.
    links.intro = entry.intro ?? links.intro;
  }

  /** Типы контента: movie/serial/concert/docu/tvshow/3d/4k. */
  app.get("/types", async () => ({
    types: ITEM_TYPES.map((id) => ({ id, title: ITEM_TYPE_TITLES[id] })),
  }));

  app.get("/genres", async (request) => {
    const q = parseOrThrow(genresQuerySchema, request.query ?? {});
    return { genres: await listGenres(db, q.type) };
  });

  app.get("/countries", async () => ({
    countries: await listCountries(db),
  }));

  /** Список с фильтрами и cursor-пагинацией (формат фильтров как в API 1.3). */
  app.get("/items", async (request) => {
    let filters: ReturnType<typeof parseCatalogQuery>;
    try {
      filters = parseCatalogQuery(request.query ?? {});
    } catch (err) {
      const zod = await import("zod");
      if (err instanceof zod.ZodError) {
        const { badRequest } = await import("../lib/http");
        throw badRequest("validation_error", "Invalid request", (err as InstanceType<typeof zod.ZodError>).issues);
      }
      throw err;
    }
    return listItems(db, filters);
  });

  /** Батч карточек по id: ленты с известными ids («продолжить смотреть»)
   * берут всё одним запросом вместо N getItem. */
  app.get("/items/summary", async (request) => {
    const q = parseOrThrow(itemsSummaryQuerySchema, request.query ?? {});
    return { items: await getItemsByIds(db, q.ids) };
  });

  // Подсказки в шапке (поиск по мере ввода): только локальный каталог, без
  // on-the-fly discovery (иначе каждое нажатие клавиши ходило бы в rutor),
  // свой лимит — 8 результатов, щедрый rate limit под debounce-запросы.
  app.get(
    "/items/suggest",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const q = parseOrThrow(searchRawQuerySchema, request.query ?? {});
      const result = await searchItems(db, { q: q.q, type: q.type, field: "title", limit: Math.min(q.limit, 8) });
      reply.header("cache-control", "public, max-age=60");
      return result;
    },
  );

  app.get(
    "/items/search",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
    const q = parseOrThrow(searchRawQuerySchema, request.query ?? {});
    let result = await searchItems(db, {
      q: q.q,
      type: q.type,
      field: q.field,
      limit: q.limit,
    });

    // On-the-fly discovery: ходит в rutor и TMDb и пишет в БД — только для
    // авторизованных. Аноним ищет по локальному каталогу.
    if (result.items.length === 0 && q.q.trim().length >= 2) {
      const user = await optionalUser(request);
      if (user) {
        try {
          const queryTerm = q.q.trim();
          const releases = await streamResolver.rutor.search(queryTerm);
          if (releases.length > 0) {
            const topRel = releases[0]!;
            const m = topRel.title.match(/^([^/[(]+)(?:\/\s*([^/[(]+))?\s*(?:\[[^\]]+\])?\s*(?:\((\d{4})\))?/);
            let title = m ? m[1]!.trim() : queryTerm;
            let originalTitle = m?.[2] ? m[2]!.trim() : null;
            let year = m?.[3] ? parseInt(m[3]!, 10) : topRel.year ?? null;
            let plot = `Релиз: ${topRel.title}`;
            let rating = 0;
            let posterSmall: string | null = null;
            let posterMedium: string | null = null;
            let posterBig: string | null = null;
            let trailerId: string | null = null;
            let trailerUrl: string | null = null;

            const tmdb = await tmdbLookup(config, title, year);
            if (tmdb) {
              title = tmdb.title;
              originalTitle = tmdb.originalTitle ?? originalTitle;
              year = tmdb.year ?? year;
              if (tmdb.plot) plot = tmdb.plot;
              if (tmdb.rating > 0) rating = tmdb.rating;
              posterSmall = tmdb.posterSmall;
              posterMedium = tmdb.posterMedium;
              posterBig = tmdb.posterBig;
              trailerId = tmdb.trailerId;
              trailerUrl = tmdb.trailerUrl;
            }

            // Дедуп: тот же тайтл с тем же годом уже в каталоге — не плодим дубли.
            const dupConds = [sql`${items.title} ilike ${title}`];
            if (year != null) dupConds.push(eq(items.year, year));
            const dup = await db
              .select({ id: items.id })
              .from(items)
              .where(and(...dupConds))
              .limit(1);

            if (dup.length === 0) {
              const isSerial = /s\d+|сезон|серии/i.test(topRel.title);

              await db.insert(items).values({
                type: isSerial ? "serial" : "movie",
                title,
                originalTitle,
                year,
                plot,
                rating,
                quality: topRel.quality.includes("2160") ? 2160 : 1080,
                posterSmall,
                posterMedium,
                posterBig,
                trailerId,
                trailerUrl,
              });
              result = await searchItems(db, {
                q: queryTerm,
                type: q.type,
                field: q.field,
                limit: q.limit,
              });
            }
          }
        } catch {
          // Discovery не должен ломать поиск: локальный результат уже есть.
        }
      }
    }

    return result;
  });

  // Кэш лент shortcuts: hero/rails главной дергают fresh/hot/popular на
  // каждый ISR-рендер. 60с в памяти снимает шаблонный SQL-шторм.
  const shortcutCache = new Map<string, { at: number; page: ItemPage }>();
  const SHORTCUT_CACHE_TTL_MS = 60_000;

  for (const kind of ["fresh", "hot", "popular"] as const) {
    app.get(`/items/${kind}`, async (request) => {
      const q = parseOrThrow(shortcutQuerySchema, request.query ?? {});
      const cacheKey = `${kind}:${q.type ?? ""}:${q.limit}:${q.cursor ?? ""}`;
      const cached = shortcutCache.get(cacheKey);
      if (cached && Date.now() - cached.at < SHORTCUT_CACHE_TTL_MS) {
        return cached.page;
      }
      const page = await shortcutItems(db, kind, {
        type: q.type,
        limit: q.limit,
        cursor: q.cursor ?? null,
      });
      shortcutCache.set(cacheKey, { at: Date.now(), page });
      if (shortcutCache.size > 200) {
        // Простейшая гигиена: режем протухшие записи.
        const now = Date.now();
        for (const [k, v] of shortcutCache) {
          if (now - v.at >= SHORTCUT_CACHE_TTL_MS) shortcutCache.delete(k);
        }
      }
      return page;
    });
  }

  app.get("/items/:id", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    let item = await getItem(db, id);
    if (!item) {
      // Карточку влили в другую (склейка дублей) — отдаём выжившую;
      // веб по item.id ≠ :id делает постоянный редирект.
      const to = await resolveItemRedirect(db, id);
      if (to != null) item = await getItem(db, to);
    }
    if (!item) throw notFound(`Item ${id} not found`);

    // Сериал без эпизодов (заливка из TMDb) — дотягиваем сезоны лениво.
    // Раньше ждали всю гидрацию в request path: длинный сериал (десятки
    // сезонов, батчи по 4) держал первого зрителя десятки секунд. Теперь
    // короткий бюджет: успела — ответ уже с сезонами; не успела — едет
    // фоном (in-flight дедуп внутри), ISR-страница подхватит на
    // revalidate. Сбой гидрации больше не роняет карточку — просто
    // останется без списка серий.
    const totalEpisodes = item.seasons ? item.seasons.reduce((a, s) => a + (s.episodes?.length ?? 0), 0) : 0;
    // Триггер шире: не только пустой сериал, но и частично догидрированный (ongoing, прошлый частичный успех).
    // hydrateSerialSeasons идемпотентна и кэширует промахи на 10 мин, так что лишний вызов дешёвый.
    if (item.type === "serial" && item.tmdb.id && item.seasons && (item.seasons.length === 0 || totalEpisodes === 0)) {
      const hydrating = hydrateSerialSeasons(
        db,
        config,
        item.id,
        item.tmdb.id ?? 0,
      )
        // Свежие сезоны длинного шоу (Конан: 1216 серий в «Сезоне 1») сразу
        // раскладываем по эпизод-группам TMDb — до первого показа списка.
        .then(async (ok) => {
          if (ok) await regroupLongSeasons(db, config, id).catch(() => undefined);
          return ok;
        })
        .catch(() => false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let fast = false;
      try {
        fast = await Promise.race([
          hydrating,
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), HYDRATE_AWAIT_BUDGET_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (fast) item = (await getItem(db, id)) ?? item;
    }
    // Титров ещё нет — тянем фоном (одна проверка credits_checked_at в БД);
    // ISR-страница подхватит их на следующем revalidate.
    if (item.tmdb.id && !item.credits?.cast.length && !item.credits?.crew.length) {
      void ensureItemCredits(db, config, item.id);
    }
    return item;
  });

  const streamResolver = new StreamResolver({
    torrServerBaseUrl: config.torrServerUrl,
    torrServerPublicUrl: config.torrServerPublicUrl,
    anilibriaBaseUrl: config.anilibriaUrl,
  });
  // Выдача rutor — в Redis: общая для инстансов cluster и переживает
  // рестарт (раньше жила только в памяти процесса и обнулялась деплоем).
  if (deps.redis) streamResolver.rutor.setCache(redisSearchCache(deps.redis));

  /** Ссылки на видео/аудио/субтитры для media (их /items/media-links). */
  // Открыто и гостям: смотреть можно без входа. От перебора защищают
  // per-IP лимит, подпись /gst-ссылок (nginx secure_link) и то, что
  // резолвятся только существующие пары (item, media) из каталога.
  app.get(
    "/items/:id/media-links",
    {
      config: { rateLimit: { max: 40, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const { mid } = parseOrThrow(mediaLinksQuerySchema, request.query ?? {});
    const info: ResolveInfo = { src: "local" };
    const started = Date.now();
    const links = await resolveMediaLinks(id, mid, info);
    // Откуда взялись ссылки — для RUM: TTFF плеера помечается «холодным»,
    // если резолв шёл вживую (rutor/AniLibria/TorrServer), а не из кэшей.
    reply.header("server-timing", `resolve;desc="${info.src}";dur=${Date.now() - started}`);
    return signStreamLinks(links, config.gstLinkSecret);
    },
  );

  /**
   * Откуда ссылки: local — свои файлы/HLS в БД, memory — кэш процесса,
   * db — сохранённый резолв (stream_links), live — живой резолв.
   */
  interface ResolveInfo {
    src: "local" | "memory" | "db" | "live";
  }

  async function resolveMediaLinks(id: number, mid: number, info: ResolveInfo = { src: "local" }) {
    let links = await mediaLinks(db, id, mid, config.mediaBaseUrl);
    if (!links) {
      // Чужая пара (item, media) — 404. Заглушку создаём только если у item
      // вообще нет ни одной media-строки (лонч с карточки без media).
      const anyMedia = await db
        .select({ id: media.id })
        .from(media)
        .where(eq(media.itemId, id))
        .limit(1);
      if (anyMedia.length > 0) throw notFound(`Media ${mid} not found for item ${id}`);
      // Несуществующий item — 404, а не 500 от внешнего ключа на insert.
      if (!(await getItem(db, id))) throw notFound(`Item ${id} not found`);
      const [insertedMedia] = await db
        .insert(media)
        .values({ itemId: id, partNumber: 1, title: "Основной" })
        .returning({ id: media.id });
      links = {
        mediaId: insertedMedia?.id ?? mid,
        itemId: id,
        files: [],
        audios: [],
        subtitles: [],
        posterUrl: null,
        sprites: null,
        intro: null,
      };
    }

    // Zero-storage dynamic resolution: if no pre-encoded files in DB, resolve from stream sources
    if (links.files.length === 0) {
      const cacheKey = `${id}:${links.mediaId}`;
      const cached = resolveCache.get(cacheKey);
      if (cached && Date.now() - cached.at < RESOLVE_CACHE_TTL_MS) {
        info.src = "memory";
        applyCached(links, cached);
        return links;
      }

      // L2 — БД: прогрев и список релизов переживают рестарт API. Раньше
      // кэш жил только в памяти, и каждый деплой обнулял прогретые торренты.
      const stored = await getSource(db, id, links.mediaId).catch(() => null);
      if (stored && isSourceFresh(stored, RESOLVE_DB_TTL_MS)) {
        const entry = makeEntry(stored.files, stored.audios, stored.intro, stored.warm);
        cacheResolveEntry(cacheKey, entry);
        info.src = "db";
        applyCached(links, entry);
        return links;
      }

      // In-flight дедуп: холодный резолв ходит в rutor/AniLibria/TorrServer
      // секундами — N параллельных запросов на одну пару гоняли N полных
      // резолвов (шторм по внешним сервисам, гонка за кэш).
      info.src = "live";
      let task = linkResolves.get(cacheKey);
      if (!task) {
        task = resolveZeroStorage(id, links.mediaId, stored?.warm ?? null);
        linkResolves.set(cacheKey, task);
      }
      try {
        const entry = await task;
        if (entry) {
          links.files = entry.files;
          if (entry.audios.length > 0) {
            links.audios = entry.audios;
          }
          if (entry.intro && !links.intro) {
            links.intro = entry.intro;
          }
        }
      } finally {
        linkResolves.delete(cacheKey);
      }
    }

    return links;
  }

  /** Кандидаты резолвера → строки stream_sources; прогретый — с индексом файла. */
  function toSourceRows(list: StreamCandidate[], warm: WarmRelease | null): StreamSourceCandidate[] {
    return list.map((c) => ({
      infohash: c.hash,
      magnet: c.magnet,
      title: c.title,
      quality: c.quality,
      sizeBytes: c.sizeBytes,
      voices: c.voices,
      seeds: c.seeds,
      peers: c.peers,
      fileIndex: warm && warm.magnet === c.magnet ? warm.fileIndex : null,
    }));
  }

  /** Записать найденные раздачи (фоном: ответ клиенту не ждёт БД). */
  function persistCandidates(
    target: StreamResolveTarget,
    list: StreamCandidate[],
    warm: WarmRelease | null,
  ): void {
    if (list.length === 0) return;
    void recordStreamSources(
      db,
      { itemId: target.itemId, mediaId: target.mediaId, episodeId: target.episodeId },
      toSourceRows(list, warm),
    )
      .then(() => (warm ? refreshItemPlayable(db, target.itemId, { checked: false }) : undefined))
      .catch(() => {});
  }

  /**
   * Один холодный резолв пары (item, media). Сначала — проверенные заранее
   * раздачи из stream_sources (stream-precheck воркера): тогда rutor не
   * трогаем вовсе. Пожалованные (bad) хеши не выдаются ни оттуда, ни из поиска.
   */
  async function resolveZeroStorage(
    id: number,
    mediaId: number,
    warm: WarmRelease | null,
  ): Promise<ResolveCacheEntry | null> {
    const target = await streamResolveTarget(db, id, mediaId);
    if (!target) return null;
    const sources = await getStreamSources(db, mediaId).catch(() => []);
    const known = usableStreamSources(sources, config.streamSourceTtlMs).map((r) => ({
      hash: r.infohash,
      magnet: r.magnet,
      title: r.title,
      fileIndex: r.fileIndex!,
      quality: r.quality,
      sizeBytes: r.sizeBytes,
      seeds: r.seeds,
      peers: r.peers,
    }));
    const excludeHashes = bannedStreamHashes(sources);
    const startedAt = Date.now();
    const resolved = await streamResolver.resolve({
      itemId: id,
      mediaId,
      title: target.title,
      originalTitle: target.originalTitle,
      year: target.year,
      type: target.type,
      seasonNumber: target.seasonNumber ?? undefined,
      episodeNumber: target.episodeNumber ?? undefined,
      absoluteNumber: target.absoluteNumber,
      externalSource: target.externalSource,
      externalId: target.externalId,
      // Тёплый снимок не годится, если его релиз забанили.
      warm: warm && !excludeHashes.includes(warm.hash.toLowerCase()) ? warm : null,
      known,
      excludeHashes,
    });
    // «Пустышки»: фильм или первая серия без единой раздачи — прячем тайтл
    // из лент (после двух промахов подряд), находка — возвращает обратно.
    if (target.isEntryMedia) void markSourceAvailability(db, id, resolved.files.length > 0).catch(() => {});
    if (resolved.files.length === 0) return null;

    const guessed = !resolved.warm && resolved.files.length > 0;
    const entry = makeEntry(resolved.files, resolved.audios, resolved.intro, resolved.warm);
    if (!guessed) {
      cacheResolveEntry(`${id}:${mediaId}`, entry);
    }
    console.log(
      `resolve: item=${id} media=${mediaId} in ${Date.now() - startedAt}ms ` +
        `files=${resolved.files.length} src=${resolved.torrentSource} ` +
        `warm=${resolved.warm ? "ready" : guessed ? "guess" : "pending"}`,
    );
    if (!guessed) {
      persistCandidates(target, resolved.candidates, resolved.warm);
      void saveSource(db, {
        itemId: id,
        mediaId,
        files: resolved.files,
        audios: resolved.audios,
        intro: resolved.intro,
        warm: resolved.warm,
      }).catch(() => {});
    } else {
      persistCandidates(target, resolved.candidates, null);
      // Угаданный fileIndex=1 — не в БД и не продлеваем: дождёмся точного warm
      // и только его сохраняем (патч warm + инвалидация L1, чтобы следующий
      // медиалинк перестроил URLs уже с реальным индексом).
      void streamResolver
        .warmFor(id, mediaId)
        .then((warm2) => {
          if (!warm2) return;
          const cacheKey = `${id}:${mediaId}`;
          resolveCache.delete(cacheKey);
          persistCandidates(
            target,
            resolved.candidates.filter((c) => c.magnet === warm2.magnet),
            warm2,
          );
          return patchSource(db, id, mediaId, { warm: warm2 }).catch(() => {
            return saveSource(db, {
              itemId: id,
              mediaId,
              files: resolved.files,
              audios: entry.audios,
              intro: entry.intro,
              warm: warm2,
            }).catch(() => {});
          });
        })
        .catch(() => {});
    }
    return entry;
  }

  /* ---------- «Не играет / не та серия» ----------
   * Жалоба из плеера: раздача → bad для этой серии (stream_sources), кэши
   * пары сбрасываются, следующий media-links соберёт ссылки без неё. Гостям
   * тоже можно — защищает per-IP лимит, а бан бьёт только по одной паре. */
  app.post(
    "/media/:id/report",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const { id: mediaId } = parseOrThrow(idParamsSchema, request.params);
      const body = parseOrThrow(streamReportRequestSchema, request.body ?? {});
      const [row] = await db
        .select({ itemId: media.itemId, episodeId: media.episodeId })
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);
      if (!row) throw notFound(`Media ${mediaId} not found`);
      const hash = body.hash?.toLowerCase() ?? streamHashFromUrl(body.url);
      // Сбрасываем всё, что помнит прежний набор ссылок пары.
      const cacheKey = `${row.itemId}:${mediaId}`;
      resolveCache.delete(cacheKey);
      streamResolver.invalidate(row.itemId, mediaId);
      await deleteSource(db, row.itemId, mediaId).catch(() => {});
      let banned = false;
      if (hash) {
        await reportStreamSource(db, { itemId: row.itemId, mediaId, episodeId: row.episodeId }, hash);
        banned = true;
      }
      console.log(
        `stream-report: item=${row.itemId} media=${mediaId} reason=${body.reason} hash=${hash ?? "-"}`,
      );
      return { ok: true as const, banned };
    },
  );

  /* ---------- Префетч с карточки ----------
   * Наведение/фокус на карточку → фоновый резолв первой серии (или явной
   * mid), чтобы клик «Смотреть» взял готовое. Ответ мгновенный, резолв
   * идёт фоном с потолком параллельности — карусель под мышью не должна
   * устраивать шторм по rutor. */
  let prefetchInFlight = 0;
  app.post(
    "/items/:id/prefetch",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = parseOrThrow(idParamsSchema, request.params);
      const body = parseOrThrow(prefetchRequestSchema, request.body ?? {});
      const mediaId = body.mid ?? (await entryMediaId(id));
      if (!mediaId) return { ready: false, queued: false };
      const key = `${id}:${mediaId}`;
      const l1 = resolveCache.get(key);
      if (l1 && Date.now() - l1.at < RESOLVE_CACHE_TTL_MS) return { ready: true, queued: false };
      if (linkResolves.has(key)) return { ready: false, queued: true };
      const [stored, sources] = await Promise.all([
        getSource(db, id, mediaId).catch(() => null),
        getStreamSources(db, mediaId).catch(() => []),
      ]);
      if (stored && isSourceFresh(stored, RESOLVE_DB_TTL_MS)) return { ready: true, queued: false };
      // Проверенная раздача есть — клик и так не пойдёт в rutor.
      if (usableStreamSources(sources, config.streamSourceTtlMs).length > 0) {
        return { ready: true, queued: false };
      }
      if (prefetchInFlight >= config.prefetchConcurrency) return { ready: false, queued: false };
      prefetchInFlight++;
      void resolveMediaLinks(id, mediaId)
        .catch(() => null)
        .finally(() => {
          prefetchInFlight--;
        });
      return { ready: false, queued: true };
    },
  );

  /** media, с которой стартует просмотр тайтла: фильм или первая серия первого сезона. */
  async function entryMediaId(itemId: number): Promise<number | null> {
    const rows = await db
      .select({ id: media.id })
      .from(media)
      .leftJoin(episodes, eq(episodes.id, media.episodeId))
      .leftJoin(seasons, eq(seasons.id, episodes.seasonId))
      .where(eq(media.itemId, itemId))
      .orderBy(
        sql`(${seasons.number} = 0) nulls first`,
        sql`${seasons.number} nulls first`,
        sql`${episodes.number} nulls first`,
        media.partNumber,
        media.id,
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Ленивые аудио-дорожки прогретого релиза (gst-проба). Плеер дёргает их
   * уже во время воспроизведения: проба на холодных пирах занимает до 45с
   * и не должна задерживать старт видео. Нет прогрева — просто пусто,
   * плеер остаётся на базовой дорожке.
   */
  app.get(
    "/items/:id/media-tracks",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { id } = parseOrThrow(idParamsSchema, request.params);
      const { mid } = parseOrThrow(mediaLinksQuerySchema, request.query ?? {});
      const tracks = await probeTracks(id, mid);
      const { audios } = signStreamLinks({ files: [], audios: tracks.audios }, config.gstLinkSecret);
      return { ...tracks, audios };
    },
  );

  /** Аудио-дорожки пары (item, media): L1 → БД → gst-проба прогретого релиза. */
  async function probeTracks(id: number, mid: number): Promise<MediaTracks> {
      // Пара (item, media) обязана существовать: иначе warmFor ниже запускал
      // полный внешний резолв для произвольной комбинации id.
      const [owned] = await db
        .select({ id: media.id })
        .from(media)
        .where(and(eq(media.id, mid), eq(media.itemId, id)))
        .limit(1);
      if (!owned) throw notFound(`Media ${mid} not found for item ${id}`);
      const key = `${id}:${mid}`;
      const inflight = trackProbes.get(key);
      if (inflight) return inflight;

      const task = (async (): Promise<MediaTracks> => {
        const empty: MediaTracks = { itemId: id, mediaId: mid, audios: [] };
        const cacheKey = `${id}:${mid}`;
        const l1 = resolveCache.get(cacheKey);
        if (l1?.audios.length) return { ...empty, audios: l1.audios };

        const stored = await getSource(db, id, mid).catch(() => null);
        if (stored?.audios.length) {
          cacheResolveEntry(cacheKey, makeEntry(stored.files, stored.audios, stored.intro, stored.warm));
          return { ...empty, audios: stored.audios };
        }

        const warm =
          l1?.warm ??
          stored?.warm ??
          (await streamResolver.warmFor(id, mid).catch(() => null));
        if (!warm) return empty;

        const audios = await streamResolver.tracksFor(warm);
        if (audios.length) {
          if (l1) l1.audios = audios;
          else {
            cacheResolveEntry(cacheKey, makeEntry(stored?.files ?? [], audios, stored?.intro ?? null, warm));
          }
          void patchSource(db, id, mid, { audios, warm }).catch(() => {});
        }
        return { ...empty, audios };
      })();

      trackProbes.set(key, task);
      try {
        return await task;
      } finally {
        trackProbes.delete(key);
      }
  }

  /* ---------- Фоновый прогрев ----------
   * Клик «Смотреть» не должен ждать rutor + TorrServer (холодный резолв
   * p50 ≈ 1 с, p90 ≈ 3 с, хвост до 10 с — по логам прода). Раз в
   * PREWARM_INTERVAL прогреваем то, что вероятнее всего откроют: следующие
   * серии у смотрящих, подписки/избранное, ленты главной и топ каталога.
   * Последовательно и с паузой — rutor и DHT не любят залпов. */
  if (config.prewarm) {
    let stopped = false;
    let running = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const cycle = async () => {
      if (running || stopped) return;
      running = true;
      const started = Date.now();
      let warmed = 0;
      let failed = 0;
      try {
        const rails = await Promise.all(
          (["fresh", "hot", "popular"] as const).map((k) =>
            shortcutItems(db, k, { limit: 24 }).catch(() => ({ items: [] }) as unknown as ItemPage),
          ),
        );
        const extraItemIds = rails.flatMap((p) => p.items.map((i) => i.id));
        const targets = await prewarmCandidates(db, {
          limit: config.prewarmBatch,
          topLimit: config.prewarmTop,
          extraItemIds,
          freshMs: PREWARM_FRESH_MS,
        });
        for (const t of targets) {
          if (stopped) break;
          try {
            const links = await resolveMediaLinks(t.itemId, t.mediaId ?? 0);
            if (links.files.length > 0) {
              warmed++;
              // Дорожки — только для самого ценного: gst-проба тянет голову
              // файла (заодно кладёт её в кэш TorrServer), это дорого.
              if (t.priority <= 1) {
                await probeTracks(t.itemId, links.mediaId).catch(() => null);
              }
            } else failed++;
          } catch {
            failed++;
          }
          await sleep(config.prewarmPauseMs);
        }
        console.log(
          `prewarm: targets=${targets.length} warmed=${warmed} empty=${failed} in ${Math.round((Date.now() - started) / 1000)}s`,
        );
      } catch (err) {
        console.warn("prewarm: cycle failed:", String(err).slice(0, 200));
      } finally {
        running = false;
      }
    };
    const first = setTimeout(() => void cycle(), 60_000);
    const timer = setInterval(() => void cycle(), config.prewarmIntervalMs);
    timer.unref?.();
    first.unref?.();
    app.addHook("onClose", async () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    });
  }

  app.get("/items/:id/similar", async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return similarItems(db, id);
  });
}
