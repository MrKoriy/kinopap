/**
 * Кэш zero-storage резолва: ссылки и прогретый релиз по паре (item, media).
 *
 * Раньше кэш жил в памяти API и умирал при каждом рестарте — после деплоя
 * приходилось заново ходить в rutor (до 12с) и пере-прогревать торрент,
 * из-за чего пропадали аудио-дорожки. Здесь источник правды — БД, а
 * in-memory Map в API остаётся горячим L1 поверх неё.
 */

import type { AudioTrack, IntroMarker, MediaFile, WarmRelease } from "@zal/api-client";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db";
import { mediaSources } from "../schema/index";

export interface CachedSource {
  itemId: number;
  mediaId: number;
  files: MediaFile[];
  audios: AudioTrack[];
  intro: IntroMarker | null;
  /** Хеш и индекс файла в TorrServer; null — прогрев ещё идёт или провалился. */
  warm: WarmRelease | null;
  resolvedAt: Date;
}

/** Запись пригодна, если резолвился не раньше `maxAgeMs` назад. */
export function isSourceFresh(row: { resolvedAt: Date }, maxAgeMs: number, now = Date.now()): boolean {
  return now - row.resolvedAt.getTime() < maxAgeMs;
}

/**
 * Потолок массивов в jsonb: резолв приносит до ~8 релизов с дорожками,
 * аномально длинный список — признак битого ответа источника, тащить
 * его в кэш незачем.
 */
const MAX_CACHED_TRACKS = 64;

function clampTracks<T>(list: T[]): T[] {
  return list.length > MAX_CACHED_TRACKS ? list.slice(0, MAX_CACHED_TRACKS) : list;
}

export async function getSource(
  db: Db,
  itemId: number,
  mediaId: number,
): Promise<CachedSource | null> {
  const rows = await db
    .select()
    .from(mediaSources)
    .where(and(eq(mediaSources.itemId, itemId), eq(mediaSources.mediaId, mediaId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Полная запись результата резолва (upsert по паре item/media). */
export async function saveSource(
  db: Db,
  input: Omit<CachedSource, "resolvedAt">,
): Promise<void> {
  const at = new Date();
  const files = clampTracks(input.files);
  const audios = clampTracks(input.audios);
  await db
    .insert(mediaSources)
    .values({ ...input, files, audios, resolvedAt: at })
    .onConflictDoUpdate({
      target: [mediaSources.itemId, mediaSources.mediaId],
      set: {
        files,
        audios,
        intro: input.intro,
        warm: input.warm,
        resolvedAt: at,
      },
    });
}

/**
 * Точечное обновление: warm доехал фоном, аудио-дорожки доложены пробой.
 * Записи может ещё не быть (полный saveSource допишет всё разом) — тогда
 * это no-op: без files строка с одиноким warm не должна рождаться.
 */
export async function patchSource(
  db: Db,
  itemId: number,
  mediaId: number,
  patch: { warm?: WarmRelease | null; audios?: AudioTrack[] },
): Promise<void> {
  const set: Partial<typeof mediaSources.$inferInsert> = {};
  if (patch.warm !== undefined) set.warm = patch.warm;
  if (patch.audios !== undefined) set.audios = patch.audios;
  if (Object.keys(set).length === 0) return;
  await db
    .update(mediaSources)
    .set(set)
    .where(and(eq(mediaSources.itemId, itemId), eq(mediaSources.mediaId, mediaId)));
}

/** Гигиена: протухшие записи кэша (старше `maxAgeMs`) удаляем. */
export async function purgeStaleSources(db: Db, maxAgeMs: number): Promise<number> {
  const deleted = await db
    .delete(mediaSources)
    .where(lt(mediaSources.resolvedAt, new Date(Date.now() - maxAgeMs)));
  // node-postgres отдаёт rowCount, PGlite — changes; берём что есть.
  return deleted.rowCount ?? deleted.changes ?? 0;
}
