import { type Db, items, media } from "@zal/db";
import { gt, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

/**
 * Точечный сброс ISR-кэша веба. Раз в N секунд воркер ищет тайтлы,
 * изменившиеся после прошлого прохода (items.updated_at или новые media —
 * серии, части), и шлёт их теги в POST /api/revalidate. Так новые серии
 * видны на сайте сразу, хотя страница тайтла кэшируется на час.
 *
 * Поллинг БД, а не хуки в местах записи: тайтлы меняют и воркер (автопилот,
 * fill, бэкфиллы), и API (догон дыр), и ручные скрипты — опрос ловит всё.
 * Курсор лежит в Redis, чтобы рестарт воркера не терял изменения.
 */

const CURSOR_KEY = "zal:revalidate:cursor";
/** Потолок тегов за проход: после массового fill проще сбросить «catalog». */
const MAX_ITEMS_PER_PASS = 400;

export async function changedItemIds(db: Db, since: Date, limit = MAX_ITEMS_PER_PASS): Promise<number[]> {
  const fromItems = db
    .select({ id: items.id })
    .from(items)
    .where(gt(items.updatedAt, since));
  const fromMedia = db
    .selectDistinct({ id: media.itemId })
    .from(media)
    .where(gt(media.createdAt, since));
  const rows = await db
    .select({ id: sql<number>`u.id` })
    .from(sql`(${fromItems} union ${fromMedia}) as u`)
    .limit(limit + 1);
  return rows.map((r) => Number(r.id));
}

export interface RevalidatorOptions {
  db: Db;
  redis: Redis;
  /** Внутренний адрес Next (например http://127.0.0.1:7000). */
  webUrl: string;
  secret: string;
  everyMs: number;
  fetchImpl?: typeof fetch;
}

/** Один проход: вернёт число отправленных тегов (0 — изменений нет). */
export async function revalidateOnce(opts: RevalidatorOptions, now = new Date()): Promise<number> {
  const stored = await opts.redis.get(CURSOR_KEY);
  // Первый запуск: смотрим назад на один интервал, а не на всю историю.
  const since = stored ? new Date(stored) : new Date(now.getTime() - opts.everyMs);
  const ids = await changedItemIds(opts.db, since);
  if (ids.length === 0) {
    await opts.redis.set(CURSOR_KEY, now.toISOString());
    return 0;
  }
  const tags =
    ids.length > MAX_ITEMS_PER_PASS
      ? ["catalog"]
      : ["catalog", ...ids.map((id) => `item:${id}`)];
  const res = await (opts.fetchImpl ?? fetch)(`${opts.webUrl.replace(/\/$/, "")}/api/revalidate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.secret}` },
    body: JSON.stringify({ tags }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`web revalidate: HTTP ${res.status}`);
  // Курсор двигаем только после успешной отправки: упавший веб получит те же
  // теги в следующий проход.
  await opts.redis.set(CURSOR_KEY, now.toISOString());
  return tags.length;
}

export function startRevalidator(opts: RevalidatorOptions): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sent = await revalidateOnce(opts);
      if (sent > 0) console.log(`revalidate: сброшено тегов ${sent}`);
    } catch (err) {
      console.warn("revalidate: проход не удался:", String(err).slice(0, 200));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
