/**
 * Контракт «старта видео»: жалоба на раздачу и префетч ссылок.
 * Общий для API, веба и мобилы — хеш из URL потока все извлекают одинаково.
 */
import { z } from "zod";

/** btih: hex-40 или base32-32. */
const BTIH = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;

/**
 * Хеш раздачи из ссылки на поток: /gst/<hash>/…, /gst-s/<exp>/<sig>/<hash>/…,
 * /stream?link=<hash> или /stream?link=<magnet>. null — это не торрент
 * (HLS AniLibria, ingest-файлы) или ссылка не распознана.
 */
export function streamHashFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const gst = /\/gst(?:-s\/\d+\/[\w-]+)?\/([A-Za-z0-9]{32,40})\//.exec(url);
  if (gst?.[1] && BTIH.test(gst[1])) return gst[1].toLowerCase();
  const q = url.indexOf("?");
  if (q >= 0) {
    const params = new URLSearchParams(url.slice(q + 1));
    const link = params.get("link");
    if (link) {
      if (BTIH.test(link)) return link.toLowerCase();
      const m = /xt=urn:btih:([A-Za-z0-9]{32,40})/i.exec(link);
      if (m?.[1] && BTIH.test(m[1])) return m[1].toLowerCase();
    }
  }
  return null;
}

/** Причины жалобы из плеера. */
export const STREAM_REPORT_REASONS = ["not_playing", "wrong_episode", "other"] as const;
export type StreamReportReason = (typeof STREAM_REPORT_REASONS)[number];

export const streamReportRequestSchema = z.object({
  reason: z.enum(STREAM_REPORT_REASONS),
  /** Хеш раздачи, если клиент его знает. */
  hash: z
    .string()
    .regex(BTIH)
    .optional(),
  /** Иначе — URL играющего файла (хеш извлечёт сервер). */
  url: z.string().max(4000).optional(),
});
export type StreamReportRequest = z.infer<typeof streamReportRequestSchema>;

export const streamReportResponseSchema = z.object({
  ok: z.literal(true),
  /** Раздача помечена bad: следующий media-links отдаст другую. */
  banned: z.boolean(),
});
export type StreamReportResponse = z.infer<typeof streamReportResponseSchema>;

export const prefetchRequestSchema = z.object({
  /** Конкретная серия (продолжение просмотра); иначе — первая серия/фильм. */
  mid: z.number().int().positive().optional(),
});

export const prefetchResponseSchema = z.object({
  /** Источник уже готов (кэш/проверенная раздача) — резолв не нужен. */
  ready: z.boolean(),
  /** Запущен фоновый резолв. */
  queued: z.boolean(),
});
export type PrefetchResponse = z.infer<typeof prefetchResponseSchema>;
