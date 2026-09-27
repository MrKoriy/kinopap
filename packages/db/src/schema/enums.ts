import {
  AUDIO_DUB_TYPES,
  GENRE_TYPES,
  ITEM_TYPES,
  PERSON_ROLES,
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
