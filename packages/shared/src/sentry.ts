/**
 * Sentry без SDK: событие ошибки конвертом (envelope) по HTTP. Включается
 * переменной SENTRY_DSN у API и воркера; веб шлёт ошибки в API (/v1/errors),
 * а тот — сюда. Без DSN ничего не делает. Тяжёлые SDK (≈100 КБ в бандле
 * веба, обёртки над fastify) ради «прислать стек» не нужны.
 */

export interface SentryDsn {
  url: string;
  publicKey: string;
}

/** https://<key>@o1.ingest.sentry.io/<project> → endpoint envelope. null — DSN кривой. */
export function parseSentryDsn(dsn: string | undefined | null): SentryDsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !project) return null;
    const prefix = project.includes("/") ? `/${project.slice(0, project.lastIndexOf("/"))}` : "";
    const id = project.slice(project.lastIndexOf("/") + 1);
    return { url: `${u.protocol}//${u.host}${prefix}/api/${id}/envelope/`, publicKey: u.username };
  } catch {
    return null;
  }
}

export interface SentryEventInput {
  message: string;
  stack?: string | null;
  level?: "error" | "warning" | "fatal";
  platform?: "node" | "javascript";
  release?: string | null;
  environment?: string;
  serverName?: string;
  tags?: Record<string, string>;
  url?: string | null;
}

/** Стек V8/Firefox → кадры Sentry (последний кадр — место ошибки). */
export function stackFrames(stack: string | null | undefined): Array<Record<string, unknown>> {
  if (!stack) return [];
  const frames: Array<Record<string, unknown>> = [];
  for (const line of stack.split("\n").slice(0, 50)) {
    const v8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    const ff = v8 ? null : /^(.*)@(.+?):(\d+):(\d+)$/.exec(line.trim());
    const m = v8 ?? ff;
    if (!m) continue;
    frames.push({ function: m[1] || "?", filename: m[2], lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules/.test(m[2] ?? "") });
  }
  return frames.reverse();
}

export function buildSentryEnvelope(e: SentryEventInput, now = new Date()): string {
  const eventId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const [type, ...rest] = e.message.split(":");
  const event = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: e.platform ?? "node",
    level: e.level ?? "error",
    release: e.release ?? undefined,
    environment: e.environment ?? "production",
    server_name: e.serverName,
    tags: e.tags,
    request: e.url ? { url: e.url } : undefined,
    exception: {
      values: [
        {
          type: rest.length > 0 && type && type.length < 60 ? type.trim() : "Error",
          value: rest.length > 0 && type && type.length < 60 ? rest.join(":").trim() : e.message,
          stacktrace: { frames: stackFrames(e.stack) },
        },
      ],
    },
  };
  return `${JSON.stringify({ event_id: eventId, sent_at: now.toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`;
}

/** Отправка без ожиданий и исключений: мониторинг не должен ронять сервис. */
export async function sendSentryEvent(
  dsn: SentryDsn | null,
  e: SentryEventInput,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!dsn) return false;
  // AbortSignal.timeout нет в типах React Native — собираем вручную.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetchImpl(dsn.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=kinopap/1.0, sentry_key=${dsn.publicKey}`,
      },
      body: buildSentryEnvelope(e),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
