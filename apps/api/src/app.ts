import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config";
import type { Db } from "@zal/db";
import { noopIngestQueue, type IngestQueue } from "./ingest-queue";
import { HttpError } from "./lib/http";
import { registerAuth } from "./plugins/auth";
import { authRoutes } from "./routes/auth";
import { catalogRoutes } from "./routes/catalog";
import { docsRoutes } from "./routes/docs";
import { ingestRoutes } from "./routes/ingest";
import { progressRoutes } from "./routes/progress";
import { socialRoutes } from "./routes/social";

export interface BuildAppOptions {
  db: Db;
  config: Config;
  /** Очередь ingest: BullMQ в проде, фейк в тестах. */
  queue?: IngestQueue;
  logger?: boolean;
}

/**
 * Сборка Fastify-приложения без listen — удобно для тестов (app.inject).
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  await registerAuth(app, opts.config);

  // CORS без @fastify/cors: для закрытого клуба хватает простого хука.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", opts.config.corsOrigin);
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

  app.get("/healthz", async () => ({ ok: true }));

  await app.register(
    async (scope) => {
      await authRoutes(scope, { db: opts.db, config: opts.config });
      await catalogRoutes(scope, { db: opts.db, config: opts.config });
      await ingestRoutes(scope, {
        db: opts.db,
        config: opts.config,
        queue: opts.queue ?? noopIngestQueue,
      });
      await progressRoutes(scope, { db: opts.db, config: opts.config });
      await socialRoutes(scope, { db: opts.db, config: opts.config });
    },
    { prefix: "/v1" },
  );

  await app.register(async (scope) => {
    await docsRoutes(scope);
  });

  return app;
}
