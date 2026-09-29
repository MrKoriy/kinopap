/**
 * Контракты личного кабинета: сохранённое, подборки, история просмотра и
 * сводка профиля. Всё персональное — за auth, ключ — дефолтный профиль
 * пользователя (мультипрофильность в схеме есть, API её пока не отдаёт).
 */
import { z } from "zod";
import { userSchema } from "./auth";
import { itemTypeSchema, watchStatusSchema } from "./common";

/** Лёгкая проекция тайтла в личных списках: хватает на карточку-строку. */
export const profileItemSchema = z.object({
  id: z.number().int(),
  type: itemTypeSchema,
  title: z.string(),
  year: z.number().int().nullable(),
  posterMedium: z.string().nullable(),
  rating: z.number(),
});
export type ProfileItem = z.infer<typeof profileItemSchema>;

/* ---------- Сохранённое ---------- */

export const favoriteSchema = z.object({
  itemId: z.number().int(),
  createdAt: z.string(),
  item: profileItemSchema,
});
export type FavoriteDto = z.infer<typeof favoriteSchema>;

export const favoriteListResponseSchema = z.object({ items: z.array(favoriteSchema) });
export const favoriteResponseSchema = z.object({ favorite: favoriteSchema.nullable() });

/* ---------- Подборки (lists) ---------- */

export const userListSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  isPublic: z.boolean(),
  itemCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UserListDto = z.infer<typeof userListSchema>;

export const userListDetailSchema = userListSchema.extend({
  items: z.array(profileItemSchema),
});
export type UserListDetailDto = z.infer<typeof userListDetailSchema>;

export const userListCreateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  isPublic: z.boolean().default(false),
});
export type UserListCreate = z.infer<typeof userListCreateSchema>;

export const userListUpdateSchema = userListCreateSchema.partial();
export type UserListUpdate = z.infer<typeof userListUpdateSchema>;

export const userListListResponseSchema = z.object({ items: z.array(userListSchema) });
export const userListResponseSchema = z.object({ list: userListSchema });
export const userListDetailResponseSchema = z.object({ list: userListDetailSchema });

/* ---------- История просмотра ---------- */

/**
 * Запись истории — это watch_progress, развёрнутый до человекочитаемого вида:
 * какая серия/часть, сколько просмотрено, докуда. Прогресс < 5% и завершённые
 * записи остаются в истории (в отличие от ленты «продолжить смотреть»).
 */
export const historyEntrySchema = z.object({
  itemId: z.number().int(),
  mediaId: z.number().int(),
  itemTitle: z.string(),
  posterMedium: z.string().nullable(),
  type: itemTypeSchema,
  seasonNumber: z.number().int().nullable(),
  episodeNumber: z.number().int().nullable(),
  partNumber: z.number().int().nullable(),
  mediaTitle: z.string().nullable(),
  positionSeconds: z.number().int(),
  durationSeconds: z.number().int(),
  /** Доля просмотра 0..1 (0 при неизвестной длительности). */
  progress: z.number(),
  status: watchStatusSchema,
  updatedAt: z.string(),
});
export type HistoryEntryDto = z.infer<typeof historyEntrySchema>;

export const historyListResponseSchema = z.object({
  items: z.array(historyEntrySchema),
  /** Всего записей — для «Очистить историю» и счётчика. */
  total: z.number().int(),
});

/** Очистка истории: сколько записей снято (DELETE /v1/history). */
export const clearHistoryResponseSchema = z.object({
  ok: z.boolean(),
  removed: z.number().int(),
});

/* ---------- Сводка профиля ---------- */

export const profileStatsSchema = z.object({
  favorites: z.number().int(),
  lists: z.number().int(),
  history: z.number().int(),
  watched: z.number().int(),
  inProgress: z.number().int(),
  subscriptions: z.number().int(),
  comments: z.number().int(),
});
export type ProfileStats = z.infer<typeof profileStatsSchema>;

export const profileOverviewSchema = z.object({
  user: userSchema,
  stats: profileStatsSchema,
  /** Последние записи истории — верхний блок кабинета. */
  history: z.array(historyEntrySchema),
  favorites: z.array(favoriteSchema),
  lists: z.array(userListSchema),
});
export type ProfileOverviewDto = z.infer<typeof profileOverviewSchema>;

export const profileOverviewResponseSchema = z.object({
  profile: profileOverviewSchema,
});

/* ---------- Прогресс по тайтлу (сезоны/серии) ---------- */

export const itemProgressEntrySchema = z.object({
  mediaId: z.number().int(),
  positionSeconds: z.number().int(),
  durationSeconds: z.number().int(),
  progress: z.number(),
  status: watchStatusSchema,
  updatedAt: z.string(),
});
export type ItemProgressEntry = z.infer<typeof itemProgressEntrySchema>;

/**
 * Прогресс всех media тайтла одним запросом: карточка сериала рисует галочки
 * по сериям и выбирает активный сезон, не дёргая прогресс по каждой серии.
 */
export const itemProgressSchema = z.object({
  itemId: z.number().int(),
  entries: z.array(itemProgressEntrySchema),
  /** Куда перематывать при «Продолжить»: последняя начатая серия. */
  resumeMediaId: z.number().int().nullable(),
  /** Позиция для resumeMediaId. */
  resumePositionSeconds: z.number().int(),
});
export type ItemProgressDto = z.infer<typeof itemProgressSchema>;

export const itemProgressResponseSchema = z.object({
  progress: itemProgressSchema,
});
