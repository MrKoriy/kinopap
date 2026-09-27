/**
 * Контракты ingest: source-agnostic источник (local-путь или URL),
 * черновик item'а, опции транскода и статус задачи.
 */
import { z } from "zod";
import { itemTypeSchema, qualitySchema } from "./common";

export const ingestSourceSchema = z.object({
  type: z.enum(["local", "url"]),
  /** Путь внутри подключённой папки или прямой URL источника. */
  ref: z.string().min(1),
  /** Внешние субтитры (пути/URL рядом с источником). */
  subtitleRefs: z.array(z.string().min(1)).optional(),
});
export type IngestSource = z.infer<typeof ingestSourceSchema>;

export const ingestItemSchema = z.object({
  type: itemTypeSchema.default("movie"),
  title: z.string().min(1).max(255),
  originalTitle: z.string().max(255).optional(),
  year: z.number().int().min(1880).max(2100).optional(),
  plot: z.string().optional(),
});
export type IngestItem = z.infer<typeof ingestItemSchema>;

export const ingestEpisodeSchema = z.object({
  seasonNumber: z.number().int().positive(),
  episodeNumber: z.number().int().positive(),
  title: z.string().max(255).optional(),
});

export const ingestRequestSchema = z.object({
  source: ingestSourceSchema,
  item: ingestItemSchema,
  /** Запрошенная лестница; по умолчанию 480p/720p/1080p без апскейла. */
  ladders: z.array(qualitySchema).optional(),
  episode: ingestEpisodeSchema.optional(),
});
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const ingestJobStatusSchema = z.object({
  id: z.number().int(),
  sourceType: z.string(),
  sourceRef: z.string(),
  status: z.enum(["queued", "running", "done", "failed"]),
  itemId: z.number().int().nullable(),
  mediaId: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IngestJobStatusDto = z.infer<typeof ingestJobStatusSchema>;

export const ingestResponseSchema = z.object({ job: ingestJobStatusSchema });
export type IngestResponse = z.infer<typeof ingestResponseSchema>;

/* ---------- Прогресс просмотра (watch_progress) ---------- */

export const progressSchema = z.object({
  mediaId: z.number().int(),
  itemId: z.number().int(),
  positionSeconds: z.number(),
  durationSeconds: z.number(),
  status: z.enum(["unwatched", "in_progress", "watched"]),
  updatedAt: z.string(),
});
export type ProgressDto = z.infer<typeof progressSchema>;

export const progressPutSchema = z.object({
  positionSeconds: z.number().min(0),
  durationSeconds: z.number().min(0),
});
export type ProgressPut = z.infer<typeof progressPutSchema>;

export const progressResponseSchema = z.object({
  progress: progressSchema.nullable(),
});
export const progressListResponseSchema = z.object({
  items: z.array(progressSchema),
});
