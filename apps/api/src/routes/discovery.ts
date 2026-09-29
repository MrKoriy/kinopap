/**
 * Discovery: наполнение каталога из официционного TMDb API.
 *
 * Сбор, дедуп и запись живут в `@zal/ingest` (fillCatalog) и выполняются
 * фоновой джобой в воркере: 15–20к тайтлов — это ~1500 запросов к TMDb и
 * минуты работы, которые одиночный HTTP-запрос не переживает (nginx режет
 * по таймауту, а rate limit /discover — 40 за 10 минут).
 *
 * Здесь только: авторизация (owner/admin), валидация спеки, постановка
 * задачи и отчёт о прогрессе. Без Redis (dev/тесты) fill выполняется
 * синхронно — поведение прошлого релиза сохранено.
 */

import type { Db } from "@zal/db";
import {
  DEFAULT_COUNTRIES,
  type FillProgress,
  type FillSpec,
  type FillSummary,
  fillCatalog,
} from "@zal/ingest";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import { type CatalogFillQueue, noopCatalogFillQueue } from "../ingest-queue";
import { badRequest, forbidden, notFound, parseOrThrow } from "../lib/http";
import { requireRole } from "../plugins/auth";

export const discoverBodySchema = z.object({
  /** Старый режим: тренды + популярное (страницы 1..5). */
  pages: z.coerce.number().int().min(1).max(5).optional(),
  /** Имена коллекций TMDb: импортируются все части (до 150 имён за вызов). */
  collections: z.array(z.string().min(1).max(120)).max(150).optional(),
  /** Годы для массового fill: discover по году выпуска, по популярности. */
  years: z.array(z.coerce.number().int().min(1950).max(2035)).max(90).optional(),
  /** Страниц discover на год (20 тайтлов на страницу). */
  yearPages: z.coerce.number().int().min(1).max(10).optional(),
  /** Порог голосов TMDb: ниже — уже не « кино », а случайные строки. */
  minVotes: z.coerce.number().int().min(0).max(500).optional(),
  /** Жанровая матрица (хвост) — включается по умолчанию вместе с годами.
   * z.boolean: тело — JSON, булевы приходят настоящими. coerce.boolean
   * читал строку "false" как true. */
  genreMatrix: z.boolean().optional(),
  genrePages: z.coerce.number().int().min(1).max(5).optional(),
  /** Discover по странам происхождения (KR/JP/IN/…). */
  countries: z.array(z.string().length(2)).max(30).optional(),
  countryPages: z.coerce.number().int().min(1).max(5).optional(),
  /** top_rated + trending + популярное. */
  lists: z.boolean().optional(),
  /** Импорт каталога AniLibria (по умолчанию включён). */
  anime: z.boolean().optional(),
  /** Сколько аниме-релизов импортировать за прогон. */
  animeLimit: z.coerce.number().int().min(1).max(5000).optional(),
  /** Склейка дублей после заливки (по умолчанию включена). */
  dedupe: z.boolean().optional(),
});

type DiscoverBody = z.infer<typeof discoverBodySchema>;

/** Тело запроса → спека fill-джобы. */
export function buildFillSpec(body: DiscoverBody): FillSpec {
  // Пустое тело — ошибка клиента, а не «заливай всё»: anime по умолчанию
  // включается только когда запрос хоть что-то явно запросил.
  if (Object.keys(body).length === 0) {
    throw badRequest(
      "empty_discover",
      "Укажи хотя бы один источник: years, collections, pages или anime",
    );
  }
  const spec: FillSpec = {};

  if (body.years?.length) {
    spec.years = body.years;
    spec.yearPages = body.yearPages ?? 5;
    spec.genreMatrix = body.genreMatrix ?? true;
    spec.genrePages = body.genrePages ?? 2;
    spec.lists = body.lists ?? true;
    spec.countries = body.countries ?? [...DEFAULT_COUNTRIES];
    spec.countryPages = body.countryPages ?? 3;
  } else if (body.pages) {
    spec.lists = true;
  }

  if (body.collections?.length) spec.collections = body.collections;
  if (body.minVotes != null) {
    spec.minVotesMovie = body.minVotes;
    spec.minVotesTv = Math.max(0, Math.round(body.minVotes * 0.6));
  }
  // Аниме по умолчанию всегда: AniLibria даёт мгновенный HLS без торрентов.
  spec.anime = body.anime ?? true;
  if (body.animeLimit != null) spec.animeLimit = body.animeLimit;
  // Склейка дублей тоже по умолчанию: заливка не должна плодить вариации.
  spec.dedupe = body.dedupe ?? true;

  const hasTmdbSource =
    !!spec.years?.length || !!spec.collections?.length || spec.lists === true;
  if (!hasTmdbSource && !spec.anime) {
    throw badRequest(
      "empty_discover",
      "Укажи хотя бы один источник: years, collections, pages или anime",
    );
  }
  return spec;
}

export async function discoveryRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config; catalogQueue?: CatalogFillQueue },
): Promise<void> {
  const { db, config } = deps;
  const queue = deps.catalogQueue ?? noopCatalogFillQueue;

  app.post(
    "/discover",
    {
      // Раньше роль проверяли в теле хендлера повторным jwtVerify —
      // authenticate уже всё сделал, дублируем только allow-list.
      preHandler: [app.authenticate, requireRole("owner", "admin")],
      config: { rateLimit: { max: 40, timeWindow: "10 minutes" } },
    },
    async (request) => {
      if (!config.tmdbApiKey) {
        throw forbidden("TMDB_API_KEY is not configured on the server");
      }
      const body = parseOrThrow(discoverBodySchema, request.body ?? {});
      const spec = buildFillSpec(body);

      // Без Redis (dev/тесты) — считаем прямо в запросе, как раньше.
      if (queue === noopCatalogFillQueue) {
        const summary = await fillCatalog({
          db,
          apiKey: config.tmdbApiKey ?? "",
          spec,
          anilibriaBaseUrl: config.anilibriaUrl,
          onProgress: (p: FillProgress) => {
            console.log(
              `discover: ${p.phase} fetched=${p.fetched} added=${p.added} total=${p.total}`,
            );
          },
        });
        return { queued: false, summary };
      }

      const { jobId } = await queue.enqueue({ kind: "catalog-fill", spec });
      return { queued: true, jobId };
    },
  );

  /** Прогресс и результат фонового fill: { job: "<id>" }. */
  app.get(
    "/discover/status",
    {
      preHandler: [app.authenticate, requireRole("owner", "admin")],
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request) => {
      const q = parseOrThrow(
        z.object({ job: z.string().min(1).max(64) }),
        request.query ?? {},
      );
      const status = await queue.status(q.job);
      if (!status) throw notFound(`Catalog fill job ${q.job} not found`);
      return status;
    },
  );
}

export type { FillProgress, FillSpec, FillSummary };
