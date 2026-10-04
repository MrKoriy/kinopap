import { constants as zlibConstants } from "node:zlib";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "@zal/db";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Config } from "./config";
import {
  type CatalogFillQueue,
  type IngestQueue,
  noopCatalogFillQueue,
  noopIngestQueue,
} from "./ingest-queue";
import { HttpError } from "./lib/http";
import { registerObservability } from "./lib/observability";
import { registerAuth } from "./plugins/auth";
import { authRoutes } from "./routes/auth";
import { catalogRoutes } from "./routes/catalog";
import { discoveryRoutes } from "./routes/discovery";
import { docsRoutes } from "./routes/docs";
import { ingestRoutes } from "./routes/ingest";
import { metricsRoutes } from "./routes/metrics";
import { notifyRoutes } from "./routes/notify";
import { onlineRoutes } from "./routes/online";
import { profileRoutes } from "./routes/profile";
import { progressRoutes } from "./routes/progress";
import { socialRoutes } from "./routes/social";

export interface BuildAppOptions {
  db: Db;
  config: Config;
  /** Очередь ingest: BullMQ в проде, фейк в тестах. */
  queue?: IngestQueue;
  /** Очередь фонового fill-каталога: BullMQ в проде, noop в тестах. */
  catalogQueue?: CatalogFillQueue;
  /** Общий Redis (прод): счётчики rate limit и кэш выдачи rutor — одни на
   * все инстансы PM2 cluster. Без него (тесты, dev) — память процесса. */
  redis?: Redis | null;
  logger?: boolean;
}

/**
 * Сборка Fastify-приложения без listen — удобно для тестов (app.inject).
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Прод за nginx: без этого request.ip — всегда IP прокси, и rate limit
    // (логин, глобальный) режет всех клиентов как одного пользователя.
    // Управляется конфигом: при прямом доступе к порту TRUST_PROXY=0,
    // иначе подделка X-Forwarded-For обходит per-IP лимиты.
    trustProxy: opts.config.trustProxy,
  });

  await registerAuth(app, opts.config, opts.db);
  (app as unknown as { db: Db }).db = opts.db;

  // Rate limit: точечные лимиты — на роутах (auth-брутфорс, поиск с
  // внешними запросами, discovery). Глобальный потолок защитный, не душащий:
  // HLS-сегменты и healthz исключены на своих роутах.
  await app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: "1 minute",
    // В cluster лимиты в памяти делились бы на число инстансов (каждый
    // считает своё) — с Redis счётчик общий. Redis лёг — не роняем запросы.
    ...(opts.redis ? { redis: opts.redis, nameSpace: "zal-rl:", skipOnError: true } : {}),
  });

  // Сжатие ответов: списки серий и ленты — десятки КБ JSON, brotli режет их
  // в 6–10 раз. Качество 4 вместо дефолтных 11: на лету 11 съедает CPU, а
  // выигрыш по размеру против 4 — проценты. nginx сжатый ответ не трогает.
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip"],
    brotliOptions: {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      },
    },
  });

  // Refresh-токен веба живёт в httpOnly-cookie (XSS не крадёт сессию),
  // мобила шлёт его телом — оба пути поддерживаются.
  await app.register(cookie);

  // CORS без @fastify/cors: список разрешённых origin'ов через запятую.
  // Конкретные origin'ы отражаются + credentials (cookie); "*" — публично.
  const allowedOrigins = opts.config.corsOrigin
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAll = allowedOrigins.includes("*");

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (allowAll) {
      reply.header("access-control-allow-origin", "*");
    } else if (origin && allowedOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    reply.header("access-control-allow-headers", "authorization, content-type");
    reply.header(
      "access-control-allow-methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  // Публичные GET без токена — кэшируемы браузером и nginx-микрокэшем: ленты,
  // карточки и справочники одинаковы для всех гостей. С токеном — как было
  // (персональные поля в ответе не должны оседать в общих кэшах).
  const PUBLIC_CACHEABLE =
    /^\/v1\/(?:items(?:\/(?:fresh|hot|popular|summary|\d+(?:\/similar)?))?|genres|countries|types)(?:\?|$)/;
  app.addHook("onSend", async (request, reply) => {
    if (
      request.method === "GET" &&
      reply.statusCode === 200 &&
      !request.headers.authorization &&
      !reply.getHeader("cache-control") &&
      PUBLIC_CACHEABLE.test(request.url)
    ) {
      // s-maxage — для общего кэша (nginx proxy_cache): ему можно держать
      // ответ дольше браузера, гости получают его без похода в БД.
      reply.header(
        "cache-control",
        "public, max-age=30, s-maxage=60, stale-while-revalidate=600",
      );
    }
  });

  // Server-Timing: сколько запрос провёл в API (видно в DevTools и в RUM
  // через Resource Timing). Маршрут может добавить свои метрики раньше
  // (media-links: resolve;desc="live") — дописываем, а не затираем.
  const startedAt = new WeakMap<object, bigint>();
  app.addHook("onRequest", async (request) => {
    startedAt.set(request.raw, process.hrtime.bigint());
  });
  app.addHook("onSend", async (request, reply) => {
    const t0 = startedAt.get(request.raw);
    if (t0 === undefined) return;
    const dur = Number(process.hrtime.bigint() - t0) / 1e6;
    const prev = reply.getHeader("server-timing");
    const own = `app;dur=${dur.toFixed(1)}`;
    reply.header("server-timing", prev ? `${String(prev)}, ${own}` : own);
    reply.header("timing-allow-origin", "*");
  });

  app.addHook("onSend", async (_request, reply) => {
    // Базовые security-заголовки: API отдаёт JSON, но docs-роут рисует
    // HTML — nosniff и frameguard нужны и там.
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    // HSTS осмыслен только за TLS: включаем вместе с secure-cookie.
    if (opts.config.cookieSecure) {
      reply.header("strict-transport-security", "max-age=31536000");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    // Ошибки фреймворка несут свой статус: битый JSON-тело (400),
    // неподдерживаемый content-type (415), ошибки схемы маршрута. Раньше
    // всё это сворачивалось в 500 и ложило шум в лог.
    const fwStatus = (error as { statusCode?: unknown }).statusCode;
    const status = typeof fwStatus === "number" ? fwStatus : 500;
    // 429 от @fastify/rate-limit — до общей 4xx-ветки: bad_request и
    // "Malformed request" тут врут, а message плагина ("Rate limit
    // exceeded, retry in ...") говорит клиенту, сколько ждать. Заголовки
    // retry-after / x-ratelimit-* плагин уже поставил сам — не дублируем.
    if (status === 429) {
      const fwMessage = (error as { message?: unknown }).message;
      request.log.warn(error);
      reply.code(429).send({
        error: {
          code: "rate_limited",
          message:
            typeof fwMessage === "string" && fwMessage
              ? fwMessage
              : "Too many requests",
        },
      });
      return;
    }
    if (status >= 400 && status < 500) {
      request.log.warn(error);
      reply.code(status).send({
        error: {
          code: "bad_request",
          message: status === 415 ? "Unsupported media type" : "Malformed request",
        },
      });
      return;
    }
    request.log.error(error);
    reply
      .code(500)
      .send({ error: { code: "internal", message: "Internal server error" } });
  });

  // 404 тоже в едином формате ошибок, а не fastify-дефолт с message наверху.
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: "not_found",
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });

  registerObservability(app, { db: opts.db, config: opts.config });

  // healthz поллится балансировщиками/PM2 — вне rate limit.
  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ ok: true }));
  // readiness: проверяет БД (и Redis если есть), чтобы оркестратор не лил трафик на неготовый инстанс.
  app.get("/readyz", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await (opts.db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
        (await import("drizzle-orm")).sql`select 1`,
      );
      return { ok: true };
    } catch {
      reply.code(503);
      return { ok: false };
    }
  });

  await app.register(
    async (scope) => {
      await authRoutes(scope, { db: opts.db, config: opts.config });
      await catalogRoutes(scope, { db: opts.db, config: opts.config, redis: opts.redis ?? null });
      await discoveryRoutes(scope, {
        db: opts.db,
        config: opts.config,
        catalogQueue: opts.catalogQueue ?? noopCatalogFillQueue,
      });
      await ingestRoutes(scope, {
        db: opts.db,
        config: opts.config,
        queue: opts.queue ?? noopIngestQueue,
      });
      await progressRoutes(scope, { db: opts.db, config: opts.config });
      await profileRoutes(scope, { db: opts.db, config: opts.config });
      await socialRoutes(scope, { db: opts.db, config: opts.config });
      await notifyRoutes(scope, { db: opts.db, config: opts.config });
      await onlineRoutes(scope, { db: opts.db, config: opts.config, redis: opts.redis ?? null });
      // Свой под-плагин: парсер text/plain (sendBeacon) не должен влиять на
      // остальные маршруты.
      await scope.register(async (m) => metricsRoutes(m, { db: opts.db, config: opts.config }));
    },
    { prefix: "/v1" },
  );

  await app.register(async (scope) => {
    await docsRoutes(scope);
  });

  return app;
}
