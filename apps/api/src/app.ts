import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "@zal/db";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config";
import {
  type CatalogFillQueue,
  type IngestQueue,
  noopCatalogFillQueue,
  noopIngestQueue,
} from "./ingest-queue";
import { HttpError } from "./lib/http";
import { registerAuth } from "./plugins/auth";
import { authRoutes } from "./routes/auth";
import { catalogRoutes } from "./routes/catalog";
import { discoveryRoutes } from "./routes/discovery";
import { docsRoutes } from "./routes/docs";
import { ingestRoutes } from "./routes/ingest";
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
  logger?: boolean;
}

/**
 * Сборка Fastify-приложения без listen — удобно для тестов (app.inject).
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  await registerAuth(app, opts.config);

  // Rate limit: точечные лимиты — на роутах (auth-брутфорс, поиск с
  // внешними запросами, discovery). Глобальный потолок защитный, не душащий:
  // HLS-сегменты и healthz исключены на своих роутах.
  await app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: "1 minute",
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
      reply.code(204).send();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    request.log.error(error);
    reply
      .code(500)
      .send({ error: { code: "internal", message: "Internal server error" } });
  });

  // healthz поллится балансировщиками/PM2 — вне rate limit.
  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ ok: true }));

  await app.register(
    async (scope) => {
      await authRoutes(scope, { db: opts.db, config: opts.config });
      await catalogRoutes(scope, { db: opts.db, config: opts.config });
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
    },
    { prefix: "/v1" },
  );

  await app.register(async (scope) => {
    await docsRoutes(scope);
  });

  return app;
}
