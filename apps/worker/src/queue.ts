/**
 * Очередь транскода. Источники — source-agnostic: job несёт ref
 * (путь или URL) и черновик item'а, никакой семантики чужих пираток.
 *
 * Раньше здесь жили ещё probe/transcode-виды джоб — низкоуровневые
 * payload'ы без единого продюсера (API ставит только полный ingest).
 * Удалены как мёртвый код; probeMedia/transcodeToHls остаются частью
 * ingest-пайплайна в @zal/ingest.
 */

import {
  ingestEpisodeSchema,
  ingestItemSchema,
  ingestSourceSchema,
  type Quality,
  qualitySchema,
} from "@zal/api-client";
import { z } from "zod";

export const TRANSCODE_QUEUE = "transcode";

export type { Quality };
export { qualitySchema };

/** Полный ingest: pull → probe → ffmpeg → ассеты → публикация в каталог. */
export const ingestJobSchema = z.object({
  kind: z.literal("ingest"),
  jobId: z.number().int().positive(),
  source: ingestSourceSchema,
  item: ingestItemSchema,
  ladders: z.array(qualitySchema).optional(),
  episode: ingestEpisodeSchema.optional(),
});

export const transcodeJobPayloadSchema = ingestJobSchema;

export type IngestJobData = z.infer<typeof ingestJobSchema>;
export type TranscodeJobPayload = z.infer<typeof transcodeJobPayloadSchema>;
