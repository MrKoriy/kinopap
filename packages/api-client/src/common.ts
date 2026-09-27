import { z } from "zod";

/** Типы видео-контента (модель API 1.3 kino.pub + 4k). */
export const ITEM_TYPES = [
  "movie",
  "serial",
  "concert",
  "documovie",
  "docuserial",
  "tvshow",
  "3d",
  "4k",
] as const;

/** Типы жанров (у kino.pub жанры разделены по типам контента). */
export const GENRE_TYPES = ["movie", "music", "docu", "tvshow"] as const;

export const PERSON_ROLES = [
  "actor",
  "director",
  "writer",
  "producer",
  "composer",
  "voice",
] as const;

/** Типы озвучки: MVO/UVO/DVO/AVO + оригинал + дубляж. */
export const AUDIO_DUB_TYPES = ["mvo", "uvo", "dvo", "avo", "original", "dub"] as const;

export const WATCH_STATUSES = ["unwatched", "in_progress", "watched"] as const;

export const USER_ROLES = ["owner", "admin", "member"] as const;

/** Рейды качества (лестница HLS). */
export const QUALITIES = ["480p", "720p", "1080p", "2160p"] as const;

export const itemTypeSchema = z.enum(ITEM_TYPES);
export const genreTypeSchema = z.enum(GENRE_TYPES);
export const personRoleSchema = z.enum(PERSON_ROLES);
export const audioDubTypeSchema = z.enum(AUDIO_DUB_TYPES);
export const watchStatusSchema = z.enum(WATCH_STATUSES);
export const userRoleSchema = z.enum(USER_ROLES);
export const qualitySchema = z.enum(QUALITIES);

export type ItemType = z.infer<typeof itemTypeSchema>;
export type GenreType = z.infer<typeof genreTypeSchema>;
export type PersonRole = z.infer<typeof personRoleSchema>;
export type AudioDubType = z.infer<typeof audioDubTypeSchema>;
export type WatchStatus = z.infer<typeof watchStatusSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type Quality = z.infer<typeof qualitySchema>;

/** Единая форма ошибки API: { error: { code, message, details? } }. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** Человекочитаемые имена типов (для /v1/types и UI). */
export const ITEM_TYPE_TITLES: Record<ItemType, string> = {
  movie: "Фильмы",
  serial: "Сериалы",
  concert: "Концерты",
  documovie: "Документальные фильмы",
  docuserial: "Документальные сериалы",
  tvshow: "ТВ-шоу",
  "3d": "3D",
  "4k": "4K",
};
