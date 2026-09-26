/**
 * Очередь транскода. Источники — source-agnostic: job несёт ключ уже
 * загруженного исходника (S3-ключ), никаких ссылок на чужие пиратки.
 */
import { z } from "zod";

export const TRANSCODE_QUEUE = "transcode";

export const QUALITIES = ["480p", "720p", "1080p", "2160p"] as const;
export const qualitySchema = z.enum(QUALITIES);
export type Quality = z.infer<typeof qualitySchema>;

/** ffprobe: вытащить метаданные исходника (дорожки, длительность, кодеки). */
export const probeJobSchema = z.object({
  kind: z.literal("probe"),
  mediaId: z.number().int().positive(),
  sourceKey: z.string().min(1),
});

/** ffmpeg: HLS-лестница + WebVTT + тумбы/спрайты. */
export const transcodeJobSchema = z.object({
  kind: z.literal("transcode"),
  mediaId: z.number().int().positive(),
  sourceKey: z.string().min(1),
  ladders: z.array(qualitySchema).nonempty().default(["720p", "1080p"]),
});

export const transcodeJobPayloadSchema = z.discriminatedUnion("kind", [
  probeJobSchema,
  transcodeJobSchema,
]);

export type ProbeJob = z.infer<typeof probeJobSchema>;
export type TranscodeJob = z.infer<typeof transcodeJobSchema>;
export type TranscodeJobPayload = z.infer<typeof transcodeJobPayloadSchema>;
