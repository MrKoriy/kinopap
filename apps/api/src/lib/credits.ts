/**
 * Актёры и команда в процессе API: дотягиваем титры при гидрации сериала и
 * при первом открытии карточки, у которой их ещё не искали (фоном — ответ
 * карточки их не ждёт). Массовый догон — бэкфилл воркера (backfill-credits).
 */
import { type Db, items, markCreditsChecked, replaceItemCredits } from "@zal/db";
import { creditsToRows, parseTmdbCredits, type RawTmdbDetails, tmdbKindOf } from "@zal/ingest";
import { eq } from "drizzle-orm";
import type { Config } from "../config";
import { tmdbGet } from "./tmdb";

const pending = new Map<number, Promise<number>>();

/** Тянет и записывает титры; возвращает число людей (0 — пусто/сбой). */
export async function fetchItemCredits(
  db: Db,
  config: Config,
  item: { id: number; type: string; tmdbId: number; tmdbType?: string | null },
): Promise<number> {
  const kind = tmdbKindOf(item);
  const details = await tmdbGet<RawTmdbDetails>(
    config,
    `/${kind}/${item.tmdbId}?append_to_response=${kind === "tv" ? "aggregate_credits" : "credits"}`,
  );
  if (!details) return 0; // сбой TMDb — не помечаем, повторим позже
  const rows = creditsToRows(parseTmdbCredits(details));
  if (rows.people.length === 0 && !rows.backdropUrl) {
    await markCreditsChecked(db, item.id);
    return 0;
  }
  return replaceItemCredits(db, item.id, rows.people, { backdropUrl: rows.backdropUrl });
}

/**
 * Титры, если их ещё не искали. Идемпотентно и с дедупом в полёте: десяток
 * одновременных открытий карточки — один запрос к TMDb.
 */
export function ensureItemCredits(db: Db, config: Config, itemId: number): Promise<number> {
  if (!config.tmdbApiKey) return Promise.resolve(0);
  const inFlight = pending.get(itemId);
  if (inFlight) return inFlight;
  const run = (async () => {
    const [row] = await db
      .select({ id: items.id, type: items.type, tmdbId: items.tmdbId, tmdbType: items.tmdbType, checked: items.creditsCheckedAt })
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1);
    if (!row?.tmdbId || row.checked) return 0;
    return fetchItemCredits(db, config, { ...row, tmdbId: row.tmdbId });
  })()
    .catch(() => 0)
    .finally(() => pending.delete(itemId));
  pending.set(itemId, run);
  return run;
}
