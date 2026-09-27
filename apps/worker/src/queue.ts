/**
 * Очередь транскода. Источники — source-agnostic: job несёт ref
 * (путь или URL) и черновик item'а, никакой семантики чужих пираток.
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

/** ffprobe: метаданные исходника (дорожки, длительность, кодеки). */
export const probeJobSchema = z.object({
  kind: z.literal("probe"),
  mediaId: z.number().int().positive().optional(),
  sourceKey: z.string().min(1),
});

/** ffmpeg: HLS-лестница для готового исходника (низкоуровневая задача). */
export const transcodeJobSchema = z.object({
  kind: z.literal("transcode"),
  mediaId: z.number().int().positive().optional(),
  sourceKey: z.string().min(1),
  ladders: z.array(qualitySchema).nonempty().optional(),
});

/** Полный ingest: pull → probe → ffmpeg → ассеты → публикация в каталог. */
export const ingestJobSchema = z.object({
  kind: z.literal("ingest"),
  jobId: z.number().int().positive(),
  source: ingestSourceSchema,
  item: ingestItemSchema,
  ladders: z.array(qualitySchema).optional(),
  episode: ingestEpisodeSchema.optional(),
});

export const transcodeJobPayloadSchema = z.discriminatedUnion("kind", [
  probeJobSchema,
  transcodeJobSchema,
  ingestJobSchema,
]);

export type ProbeJob = z.infer<typeof probeJobSchema>;
export type TranscodeJob = z.infer<typeof transcodeJobSchema>;
export type IngestJobData = z.infer<typeof ingestJobSchema>;
export type TranscodeJobPayload = z.infer<typeof transcodeJobPayloadSchema>;
