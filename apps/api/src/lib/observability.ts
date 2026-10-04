/**
 * Наблюдаемость API: счётчики и гистограммы запросов в формате Prometheus
 * (GET /metrics на внутреннем порту — nginx наружу его не пускает) и
 * запись 5xx в error_events (+ Sentry при SENTRY_DSN).
 */
import { type Db, listSyncState, recordError } from "@zal/db";
import { parseSentryDsn, sendSentryEvent } from "@zal/shared";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config";
import { HttpError } from "./http";

/** Инстанс PM2 cluster: Prometheus попадает то в один, то в другой — ряды не смешиваются. */
const PM = `pm="${process.env.NODE_APP_INSTANCE ?? "0"}"`;
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Series>();

  observe(method: string, route: string, status: number, ms: number): void {
    const cls = `${Math.floor(status / 100)}xx`;
    const key = `${PM},method="${method}",route="${route}",status="${cls}"`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const dkey = `${PM},route="${route}"`;
    const s = this.durations.get(dkey) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    s.count++;
    s.sum += ms;
    for (let i = 0; i < BUCKETS.length; i++) if (ms <= BUCKETS[i]!) s.buckets[i]!++;
    this.durations.set(dkey, s);
  }

  render(extra: string[] = []): string {
    const out: string[] = [
      "# HELP kinopap_http_requests_total HTTP-запросы API",
      "# TYPE kinopap_http_requests_total counter",
    ];
    for (const [k, v] of this.requests) out.push(`kinopap_http_requests_total{${k}} ${v}`);
    out.push("# HELP kinopap_http_request_duration_ms Длительность запросов API", "# TYPE kinopap_http_request_duration_ms histogram");
    for (const [k, s] of this.durations) {
      for (let i = 0; i < BUCKETS.length; i++) {
        out.push(`kinopap_http_request_duration_ms_bucket{${k},le="${BUCKETS[i]}"} ${s.buckets[i]}`);
      }
      out.push(`kinopap_http_request_duration_ms_bucket{${k},le="+Inf"} ${s.count}`);
      out.push(`kinopap_http_request_duration_ms_sum{${k}} ${s.sum.toFixed(1)}`);
      out.push(`kinopap_http_request_duration_ms_count{${k}} ${s.count}`);
    }
    const mem = process.memoryUsage();
    out.push(
      "# TYPE kinopap_process_rss_bytes gauge",
      `kinopap_process_rss_bytes{${PM}} ${mem.rss}`,
      "# TYPE kinopap_process_heap_used_bytes gauge",
      `kinopap_process_heap_used_bytes{${PM}} ${mem.heapUsed}`,
      "# TYPE kinopap_process_uptime_seconds gauge",
      `kinopap_process_uptime_seconds{${PM}} ${Math.round(process.uptime())}`,
      ...extra,
    );
    return `${out.join("\n")}\n`;
  }
}

export function registerObservability(app: FastifyInstance, opts: { db: Db; config: Config }): void {
  const metrics = new HttpMetrics();
  const sentry = parseSentryDsn(opts.config.sentryDsn);

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    if (route === "/metrics" || route === "/healthz") return;
    metrics.observe(request.method, route, reply.statusCode, reply.elapsedTime);
  });

  // 5xx: своя лента + Sentry. Ошибки клиента (4xx) — не ошибки сервиса.
  app.addHook("onError", async (request, reply, error) => {
    void reply;
    if (error instanceof HttpError) {
      if (error.status < 500) return;
    } else {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === "number" && status < 500) return;
    }
    const input = {
      source: "api" as const,
      message: `${error.name}: ${error.message}`,
      stack: error.stack ?? null,
      page: `${request.method} ${request.routeOptions?.url ?? request.url}`,
      release: opts.config.release ?? null,
    };
    void recordError(opts.db, input).catch(() => undefined);
    void sendSentryEvent(sentry, { ...input, platform: "node", tags: { source: "api" }, url: request.url });
  });

  app.get("/metrics", { config: { rateLimit: false } }, async (_request, reply) => {
    const extra: string[] = ["# TYPE kinopap_sync_age_seconds gauge", "# TYPE kinopap_sync_ok gauge"];
    for (const s of await listSyncState(opts.db).catch(() => [])) {
      const at = s.lastOkAt ? new Date(s.lastOkAt).getTime() : 0;
      extra.push(`kinopap_sync_age_seconds{task="${s.key}"} ${at ? Math.round((Date.now() - at) / 1000) : -1}`);
      extra.push(`kinopap_sync_ok{task="${s.key}"} ${s.error ? 0 : 1}`);
    }
    reply.type("text/plain; version=0.0.4");
    return metrics.render(extra);
  });
}
