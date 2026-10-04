import {
  AUDIO_DUB_TYPES,
  GENRE_TYPES,
  INGEST_JOB_STATUSES,
  ITEM_TYPES,
  PERSON_ROLES,
  QUALITIES,
  USER_ROLES,
  WATCH_STATUSES,
} from "@zal/api-client";
import { pgEnum } from "drizzle-orm/pg-core";

// Значения enum'ов живут в @zal/api-client (контракт API) — единый источник правды.
export const itemType = pgEnum("item_type", [...ITEM_TYPES]);
export const genreType = pgEnum("genre_type", [...GENRE_TYPES]);
export const personRole = pgEnum("person_role", [...PERSON_ROLES]);
export const audioDubType = pgEnum("audio_dub_type", [...AUDIO_DUB_TYPES]);
export const watchStatus = pgEnum("watch_status", [...WATCH_STATUSES]);
export const userRole = pgEnum("user_role", [...USER_ROLES]);
export const ingestJobStatus = pgEnum("ingest_job_status", [...INGEST_JOB_STATUSES]);
export const mediaQuality = pgEnum("media_quality", [...QUALITIES]);

/**
 * Статус раздачи в stream_sources: good — проверена (метаданные пришли,
 * нужный файл найден), bad — пожаловались зрители («не играет / не та
 * серия»), dead — несколько проверок подряд без пиров/метаданных.
 */
export const STREAM_SOURCE_STATUSES = ["good", "bad", "dead"] as const;
export type StreamSourceStatus = (typeof STREAM_SOURCE_STATUSES)[number];
export const streamSourceStatus = pgEnum("stream_source_status", [...STREAM_SOURCE_STATUSES]);
