/**
 * Личный кабинет: сохранённое, подборки, история просмотра, сводка.
 * Всё скоупится профилем — ключ профиля даёт вызывающий код
 * (getDefaultProfile), репозиторий про пользователей ничего не знает.
 */

import type {
  FavoriteDto,
  HistoryEntryDto,
  ItemProgressDto,
  ProfileItem,
  ProfileStats,
  UserListDetailDto,
  UserListDto,
} from "@zal/api-client";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  comments,
  episodes,
  favorites,
  items,
  listEntries,
  lists,
  media,
  seasons,
  subscriptions,
  watchProgress,
} from "../schema/index";

/** Проекция тайтла для личных списков — одна форма на все разделы. */
const profileItemColumns = {
  id: items.id,
  type: items.type,
  title: items.title,
  year: items.year,
  posterMedium: items.posterMedium,
  rating: items.rating,
};

/** Доля просмотра 0..1; при неизвестной длительности — 0, а не NaN. */
function ratio(positionSeconds: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, positionSeconds / durationSeconds));
}

/* ---------- Сохранённое ---------- */

function mapFavorite(
  createdAt: Date,
  item: ProfileItem,
): FavoriteDto {
  return { itemId: item.id, createdAt: createdAt.toISOString(), item };
}

export async function listFavorites(
  db: Db,
  profileId: number,
  limit = 100,
): Promise<FavoriteDto[]> {
  const rows = await db
    .select({ createdAt: favorites.createdAt, item: profileItemColumns })
    .from(favorites)
    .innerJoin(items, eq(items.id, favorites.itemId))
    .where(eq(favorites.profileId, profileId))
    .orderBy(desc(favorites.createdAt))
    .limit(limit);
  return rows.map((r) => mapFavorite(r.createdAt, r.item));
}

export async function getFavorite(
  db: Db,
  profileId: number,
  itemId: number,
): Promise<FavoriteDto | null> {
  const rows = await db
    .select({ createdAt: favorites.createdAt, item: profileItemColumns })
    .from(favorites)
    .innerJoin(items, eq(items.id, favorites.itemId))
    .where(and(eq(favorites.profileId, profileId), eq(favorites.itemId, itemId)))
    .limit(1);
  const row = rows[0];
  return row ? mapFavorite(row.createdAt, row.item) : null;
}

/**
 * Идемпотентно: повторный клик не создаёт вторую закладку.
 * Возвращает null, если тайтла нет в каталоге.
 */
export async function addFavorite(
  db: Db,
  profileId: number,
  itemId: number,
): Promise<FavoriteDto | null> {
  const exists = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (!exists[0]) return null;

  await db
    .insert(favorites)
    .values({ profileId, itemId })
    .onConflictDoNothing({ target: [favorites.profileId, favorites.itemId] });

  return getFavorite(db, profileId, itemId);
}

export async function removeFavorite(
  db: Db,
  profileId: number,
  itemId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(favorites)
    .where(and(eq(favorites.profileId, profileId), eq(favorites.itemId, itemId)))
    .returning({ id: favorites.id });
  return deleted.length > 0;
}

export async function countFavorites(db: Db, profileId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(favorites)
    .where(eq(favorites.profileId, profileId));
  return rows[0]?.n ?? 0;
}

/* ---------- Подборки ---------- */

function mapList(row: {
  id: number;
  title: string;
  description: string | null;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  itemCount: number;
}): UserListDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    isPublic: row.isPublic,
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listUserLists(db: Db, profileId: number): Promise<UserListDto[]> {
  const rows = await db
    .select({
      id: lists.id,
      title: lists.title,
      description: lists.description,
      isPublic: lists.isPublic,
      createdAt: lists.createdAt,
      updatedAt: lists.updatedAt,
      // count по PK колонке list_items: left join даёт 0 для пустой подборки.
      itemCount: sql<number>`count(${listEntries.itemId})::int`,
    })
    .from(lists)
    .leftJoin(listEntries, eq(listEntries.listId, lists.id))
    .where(eq(lists.profileId, profileId))
    .groupBy(lists.id)
    .orderBy(desc(lists.updatedAt));
  return rows.map(mapList);
}

export async function getUserList(
  db: Db,
  profileId: number,
  listId: number,
): Promise<UserListDetailDto | null> {
  const listRows = await db
    .select({
      id: lists.id,
      title: lists.title,
      description: lists.description,
      isPublic: lists.isPublic,
      createdAt: lists.createdAt,
      updatedAt: lists.updatedAt,
      itemCount: sql<number>`count(${listEntries.itemId})::int`,
    })
    .from(lists)
    .leftJoin(listEntries, eq(listEntries.listId, lists.id))
    .where(and(eq(lists.id, listId), eq(lists.profileId, profileId)))
    .groupBy(lists.id)
    .limit(1);
  const list = listRows[0];
  if (!list) return null;

  const itemRows = await db
    .select(profileItemColumns)
    .from(listEntries)
    .innerJoin(items, eq(items.id, listEntries.itemId))
    .where(eq(listEntries.listId, listId))
    .orderBy(listEntries.position, listEntries.addedAt);

  return { ...mapList(list), items: itemRows };
}

export async function createUserList(
  db: Db,
  profileId: number,
  input: { title: string; description?: string | null; isPublic?: boolean },
): Promise<UserListDto> {
  const [created] = await db
    .insert(lists)
    .values({
      profileId,
      title: input.title,
      description: input.description ?? null,
      isPublic: input.isPublic ?? false,
    })
    .returning();
  return mapList({ ...created!, itemCount: 0 });
}

export async function updateUserList(
  db: Db,
  profileId: number,
  listId: number,
  patch: { title?: string; description?: string | null; isPublic?: boolean },
): Promise<UserListDto | null> {
  const [updated] = await db
    .update(lists)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(lists.id, listId), eq(lists.profileId, profileId)))
    .returning();
  if (!updated) return null;
  const counts = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(listEntries)
    .where(eq(listEntries.listId, listId));
  return mapList({ ...updated, itemCount: counts[0]?.n ?? 0 });
}

export async function deleteUserList(
  db: Db,
  profileId: number,
  listId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(lists)
    .where(and(eq(lists.id, listId), eq(lists.profileId, profileId)))
    .returning({ id: lists.id });
  return deleted.length > 0;
}

/** Владелец подборки проверяется здесь — роут не дублирует логику. */
async function ownsList(db: Db, profileId: number, listId: number): Promise<boolean> {
  const rows = await db
    .select({ id: lists.id })
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.profileId, profileId)))
    .limit(1);
  return Boolean(rows[0]);
}

/** Идемпотентно; position по умолчанию — в конец подборки. */
export async function addItemToList(
  db: Db,
  profileId: number,
  listId: number,
  itemId: number,
  position?: number,
): Promise<boolean> {
  if (!(await ownsList(db, profileId, listId))) return false;

  const next = position ?? 0;
  if (position === undefined) {
    const maxRows = await db
      .select({ max: sql<number>`coalesce(max(${listEntries.position}), -1)::int` })
      .from(listEntries)
      .where(eq(listEntries.listId, listId));
    await db
      .insert(listEntries)
      .values({ listId, itemId, position: (maxRows[0]?.max ?? -1) + 1 })
      .onConflictDoNothing({
        target: [listEntries.listId, listEntries.itemId],
      });
  } else {
    await db
      .insert(listEntries)
      .values({ listId, itemId, position: next })
      .onConflictDoUpdate({
        target: [listEntries.listId, listEntries.itemId],
        set: { position: next },
      });
  }

  await db.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, listId));
  return true;
}

export async function removeItemFromList(
  db: Db,
  profileId: number,
  listId: number,
  itemId: number,
): Promise<boolean> {
  if (!(await ownsList(db, profileId, listId))) return false;
  const deleted = await db
    .delete(listEntries)
    .where(and(eq(listEntries.listId, listId), eq(listEntries.itemId, itemId)))
    .returning({ itemId: listEntries.itemId });
  return deleted.length > 0;
}

export async function countLists(db: Db, profileId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lists)
    .where(eq(lists.profileId, profileId));
  return rows[0]?.n ?? 0;
}

/* ---------- История просмотра ---------- */

/**
 * История — это watch_progress, развёрнутый до «что именно смотрели»:
 * серия (season/episode) или часть фильма. Записи без реального просмотра
 * (< 5 секунд) в историю не попадают — плеер и так не пишет меньше 5с.
 */
export async function listHistory(
  db: Db,
  profileId: number,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ items: HistoryEntryDto[]; total: number }> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const rows = await db
    .select({
      itemId: watchProgress.itemId,
      mediaId: watchProgress.mediaId,
      positionSeconds: watchProgress.positionSeconds,
      durationSeconds: watchProgress.durationSeconds,
      status: watchProgress.status,
      updatedAt: watchProgress.updatedAt,
      itemTitle: items.title,
      posterMedium: items.posterMedium,
      type: items.type,
      mediaTitle: media.title,
      partNumber: media.partNumber,
      episodeNumber: episodes.number,
      seasonNumber: seasons.number,
    })
    .from(watchProgress)
    .innerJoin(items, eq(items.id, watchProgress.itemId))
    .innerJoin(media, eq(media.id, watchProgress.mediaId))
    .leftJoin(episodes, eq(episodes.id, media.episodeId))
    .leftJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where(eq(watchProgress.profileId, profileId))
    .orderBy(desc(watchProgress.updatedAt))
    .limit(limit)
    .offset(offset);

  const totalRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(watchProgress)
    .where(eq(watchProgress.profileId, profileId));

  return {
    items: rows.map((r) => ({
      itemId: r.itemId,
      mediaId: r.mediaId,
      itemTitle: r.itemTitle,
      posterMedium: r.posterMedium,
      type: r.type,
      seasonNumber: r.seasonNumber,
      episodeNumber: r.episodeNumber,
      // part_number по умолчанию 1 — «часть» показываем только когда частей
      // действительно несколько (partNumber > 1), иначе у любого фильма
      // в истории висело бы «Часть 1».
      partNumber: r.episodeNumber === null && r.partNumber > 1 ? r.partNumber : null,
      mediaTitle: r.mediaTitle,
      positionSeconds: r.positionSeconds,
      durationSeconds: r.durationSeconds,
      progress: ratio(r.positionSeconds, r.durationSeconds),
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
    })),
    total: totalRows[0]?.n ?? 0,
  };
}

export async function clearHistory(db: Db, profileId: number): Promise<number> {
  const deleted = await db
    .delete(watchProgress)
    .where(eq(watchProgress.profileId, profileId))
    .returning({ id: watchProgress.id });
  return deleted.length;
}

export async function deleteHistoryEntry(
  db: Db,
  profileId: number,
  mediaId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(watchProgress)
    .where(
      and(eq(watchProgress.profileId, profileId), eq(watchProgress.mediaId, mediaId)),
    )
    .returning({ id: watchProgress.id });
  return deleted.length > 0;
}

/* ---------- Прогресс по тайтлу ---------- */

export async function listItemProgress(
  db: Db,
  profileId: number,
  itemId: number,
): Promise<ItemProgressDto> {
  const rows = await db
    .select()
    .from(watchProgress)
    .where(
      and(eq(watchProgress.profileId, profileId), eq(watchProgress.itemId, itemId)),
    )
    .orderBy(desc(watchProgress.updatedAt));

  // «Продолжить» — самая свежая начатая серия. Всё просмотренное (watched)
  // сюда не подставляем: клиент сам возьмёт первую непросмотренную.
  const resume = rows.find((r) => r.status === "in_progress") ?? null;

  return {
    itemId,
    entries: rows.map((r) => ({
      mediaId: r.mediaId,
      positionSeconds: r.positionSeconds,
      durationSeconds: r.durationSeconds,
      progress: ratio(r.positionSeconds, r.durationSeconds),
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
    })),
    resumeMediaId: resume?.mediaId ?? null,
    resumePositionSeconds: resume?.positionSeconds ?? 0,
  };
}

/* ---------- Сводка ---------- */

export async function profileStats(
  db: Db,
  profileId: number,
): Promise<ProfileStats> {
  const [fav, lst, hist, subs, cmts] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(favorites)
      .where(eq(favorites.profileId, profileId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(lists)
      .where(eq(lists.profileId, profileId)),
    db
      .select({
        total: sql<number>`count(*)::int`,
        watched: sql<number>`count(*) filter (where ${watchProgress.status} = 'watched')::int`,
        inProgress: sql<number>`count(*) filter (where ${watchProgress.status} = 'in_progress')::int`,
      })
      .from(watchProgress)
      .where(eq(watchProgress.profileId, profileId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(eq(subscriptions.profileId, profileId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(eq(comments.profileId, profileId), eq(comments.deleted, false))),
  ]);

  return {
    favorites: fav[0]?.n ?? 0,
    lists: lst[0]?.n ?? 0,
    history: hist[0]?.total ?? 0,
    watched: hist[0]?.watched ?? 0,
    inProgress: hist[0]?.inProgress ?? 0,
    subscriptions: subs[0]?.n ?? 0,
    comments: cmts[0]?.n ?? 0,
  };
}
