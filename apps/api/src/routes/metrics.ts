/**
 * RUM-метрики: клиенты шлют Web Vitals (LCP, TTFB, FCP, INP, CLS) и TTFF
 * плеера батчами через sendBeacon; владелец смотрит сводку p50/p75/p95,
 * долю холодных стартов и состояние фоновых задач (sync_state).
 */
import { insertRumEvents, listRecentErrors, listSyncState, recordError, rumSummary } from "@zal/db";
import { parseSentryDsn, sendSentryEvent } from "@zal/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import { parseOrThrow } from "../lib/http";
import { requireRole } from "../plugins/auth";

export const RUM_METRICS = ["LCP", "TTFB", "FCP", "INP", "CLS", "TTFF"] as const;

const rumEventSchema = z.object({
  name: z.enum(RUM_METRICS),
  // мс у всех, кроме CLS (безразмерный); потолок — 10 минут.
  value: z.number().finite().min(0).max(600_000),
  page: z.string().max(120).optional(),
  itemId: z.number().int().positive().optional(),
  rating: z.enum(["good", "needs-improvement", "poor"]).optional(),
  meta: z
    .record(z.string().max(32), z.union([z.string().max(64), z.number().finite(), z.boolean(), z.null()]))
    .refine((m) => Object.keys(m).length <= 8, "too many meta keys")
    .optional(),
});

export const rumBatchSchema = z.object({ events: z.array(rumEventSchema).min(1).max(20) });

const clientErrorSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  page: z.string().max(200).optional(),
  release: z.string().max(64).optional(),
});
export const errorBatchSchema = z.object({ errors: z.array(clientErrorSchema).min(1).max(5) });

/** Шум браузеров и расширений — не наши ошибки. */
const IGNORED_ERRORS = /ResizeObserver loop|Script error\.?$|chrome-extension:|moz-extension:|Load failed|NetworkError|AbortError|The play\(\) request was interrupted/i;

const summaryQuerySchema = z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) });

/** Маршрут без конкретных id: /item/123 → /item/[id] — иначе сводка рассыпется. */
export function normalizePage(page: string | undefined): string | null {
  if (!page) return null;
  const path = page.split("?")[0] ?? "";
  return path.replace(/\/\d+(?=\/|$)/g, "/[id]").slice(0, 120) || "/";
}

export async function metricsRoutes(app: FastifyInstance, opts: { db: Parameters<typeof insertRumEvents>[0]; config: Config }) {
  const { db } = opts;

  // sendBeacon шлёт text/plain (без CORS-preflight) — разбираем сами.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, JSON.parse(String(body)));
    } catch {
      done(null, {});
    }
  });

  app.post(
    "/metrics",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const { events } = parseOrThrow(rumBatchSchema, request.body ?? {});
      await insertRumEvents(
        db,
        events.map((e) => ({ ...e, page: normalizePage(e.page) })),
      );
      return reply.code(204).send();
    },
  );

  app.get(
    "/metrics/summary",
    { preHandler: [app.authenticate, requireRole("owner", "admin")] },
    async (request) => {
      const { hours } = parseOrThrow(summaryQuerySchema, request.query ?? {});
      const [rum, sync, errors] = await Promise.all([
        rumSummary(db, hours),
        listSyncState(db),
        listRecentErrors(db, hours, 50),
      ]);
      return { rum, sync, errors };
    },
  );

  // Ошибки веба (window.onerror, unhandledrejection, error boundary).
  const sentry = parseSentryDsn(opts.config.sentryDsn);
  app.post(
    "/errors",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, bodyLimit: 48 * 1024 },
    async (request, reply) => {
      const { errors } = parseOrThrow(errorBatchSchema, request.body ?? {});
      for (const e of errors) {
        if (IGNORED_ERRORS.test(e.message) || IGNORED_ERRORS.test(e.stack ?? "")) continue;
        const input = { source: "web" as const, message: e.message, stack: e.stack ?? null, page: normalizePage(e.page), release: e.release ?? null };
        await recordError(db, input);
        void sendSentryEvent(sentry, {
          ...input,
          platform: "javascript",
          tags: { source: "web" },
          url: e.page ?? null,
        });
      }
      return reply.code(204).send();
    },
  );
}
