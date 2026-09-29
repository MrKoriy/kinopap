/**
 * Чистая логика плеера без DOM: спрайты и интро.
 * WebVTT-парсер и активные реплики живут в @zal/shared (одинаковы для
 * веба и мобилы), здесь — только реэкспорт для обратной совместимости.
 */
import type { ItemDetail } from "@zal/api-client";

export {
  activeCues,
  cueAt,
  parseVtt,
  type SubtitleCue,
} from "@zal/shared";

/* ---------- Спрайты скраббинга ---------- */

export interface SpriteTile {
  col: number;
  row: number;
  /** CSS background-position в пикселях (со знаком). */
  backgroundPosition: string;
}

export interface SpriteMetaLike {
  intervalSeconds: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  count: number;
}

/** Тайл спрайта для момента времени. */
export function spriteTileFor(timeSeconds: number, meta: SpriteMetaLike): SpriteTile {
  const idx = Math.max(
    0,
    Math.min(meta.count - 1, Math.floor(timeSeconds / meta.intervalSeconds)),
  );
  const col = idx % meta.columns;
  const row = Math.floor(idx / meta.columns);
  return {
    col,
    row,
    backgroundPosition: `-${col * meta.tileWidth}px -${row * meta.tileHeight}px`,
  };
}

/**
 * Тайл спрайта с масштабированием под дисплейный размер превью.
 * Спрайт — сетка tileWidth×tileHeight; превью-бокс рисуется в
 * displayW×displayH. background-size и позиция обязаны масштабироваться
 * одинаково, иначе превью показывает соседний тайл/сдвиг.
 */
export function spriteTileScaledFor(
  timeSeconds: number,
  meta: SpriteMetaLike,
  displayWidth: number,
  displayHeight: number,
): SpriteTile & { backgroundSize: string } {
  const tile = spriteTileFor(timeSeconds, meta);
  return {
    ...tile,
    backgroundPosition: `-${tile.col * displayWidth}px -${tile.row * displayHeight}px`,
    backgroundSize: `${Math.round(meta.columns * displayWidth)}px ${Math.round(meta.rows * displayHeight)}px`,
  };
}

/* ---------- Маркер интро ---------- */

export function isIntroVisible(
  timeSeconds: number,
  intro: { startSeconds: number; endSeconds: number } | null | undefined,
): boolean {
  return !!intro && timeSeconds >= intro.startSeconds && timeSeconds < intro.endSeconds;
}

/** Показывать ли оверлей «следующая серия» (последние 10 секунд). */
export function isNearEnd(timeSeconds: number, duration: number): boolean {
  return duration > 0 && duration - timeSeconds <= 10 && timeSeconds < duration;
}

/* ---------- Перебор раздач ---------- */

/**
 * Первая раздача, которую ещё не пробовали, или null — если живых не осталось.
 *
 * Резолвер сортирует раздачи по сидам и размеру и не знает, транскодируется ли
 * файл: DVD-remux с MPEG-2 gst не берёт вовсе и при этом стоит первым. Поэтому
 * порядок обхода — строго по возрастанию индекса, а не «следующий по кругу»:
 * список отсортирован по качеству, и лучшая из живых должна выигрывать.
 */
export function nextAliveSource(dead: readonly number[], total: number): number | null {
  for (let i = 0; i < total; i += 1) {
    if (!dead.includes(i)) return i;
  }
  return null;
}

/**
 * Абсолютный URL потока.
 *
 * API отдаёт ссылки на потоки относительными (`/gst/...`, `/stream?...`), чтобы
 * один билд работал и по http://<ip>, и по https://<имя>: абсолютный http:// на
 * HTTPS-странице браузер блокирует как mixed content. Но внешнему плееру
 * (`iina://`, `vlc://`), буферу обмена и M3U относительный путь бесполезен —
 * там нужен полный адрес, иначе кнопка «Открыть в IINA» ломается ровно тогда,
 * когда браузер уже не справился.
 *
 * Отдельной проверки схемы нет намеренно: `new URL` возвращает `magnet:?xt=…`
 * и `https://…` без изменений (проверено на семи живых magnet-ссылках API).
 * try — на случай мусора в ответе: упасть в рендере оверлея хуже, чем отдать
 * ссылку как есть.
 */
export function absoluteStreamUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (typeof window === "undefined") return url;
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

/* ---------- Серии: список для плеера ---------- */

/**
 * Серия в том виде, в каком её показывает плеер.
 *
 * `mediaId` — не позиция в списке, а идентификатор медиа: по нему строится
 * маршрут `/watch/[itemId]/[mediaId]`. Список и переход обязаны ходить по
 * одному и тому же числу, иначе выбор серии уедет не туда.
 */
export interface PlayerEpisode {
  mediaId: number;
  /** «S2E4» у сериала, «Часть 3» у тайтла без сезонов. */
  label: string;
  title: string | null;
}

/** Группа серий: сезон сериала либо единственная группа «Части». */
export interface PlayerEpisodeGroup {
  heading: string;
  episodes: PlayerEpisode[];
}

/**
 * Серии тайтла, сгруппированные для меню плеера.
 *
 * Источника два, и оба обязательны: у сериала серии лежат в `item.seasons`,
 * а у аниме без сезонов — в `item.media` (части), как у фильма. Пустой
 * `seasons` при непустом `media` — норма, а не битые данные.
 *
 * Серии без `mediaId` пропускаются: играть их нечем, и пункт меню, ведущий в
 * никуда, хуже отсутствующего пункта. Сезон, где таких серий оказались все,
 * не попадает в список вовсе — пустой заголовок в меню выглядит как сбой.
 */
export function episodeGroups(
  item: Pick<ItemDetail, "seasons" | "media">,
): PlayerEpisodeGroup[] {
  const groups: PlayerEpisodeGroup[] = [];

  for (const season of item.seasons ?? []) {
    const episodes: PlayerEpisode[] = [];
    for (const ep of season.episodes) {
      if (ep.mediaId == null) continue;
      episodes.push({
        mediaId: ep.mediaId,
        label: `S${season.number}E${ep.number}`,
        title: ep.title,
      });
    }
    if (episodes.length > 0) {
      groups.push({ heading: season.title ?? `Сезон ${season.number}`, episodes });
    }
  }
  if (groups.length > 0) return groups;

  const parts: PlayerEpisode[] = [];
  for (const part of item.media ?? []) {
    // part.id — это и есть mediaId: страница тайтла ведёт на /watch/item/part.id.
    parts.push({
      mediaId: part.id,
      label: `Часть ${part.partNumber}`,
      title: part.title,
    });
  }
  return parts.length > 0 ? [{ heading: "Части", episodes: parts }] : [];
}

/** Плоский порядок серий — он же порядок воспроизведения. */
export function flattenEpisodes(
  groups: readonly PlayerEpisodeGroup[],
): PlayerEpisode[] {
  const out: PlayerEpisode[] = [];
  for (const group of groups) out.push(...group.episodes);
  return out;
}

/**
 * Следующая серия после указанной или null, если она последняя.
 *
 * Порядок берётся из плоского списка групп, поэтому «следующая серия»
 * на оверлее и соседний пункт в меню — всегда одна и та же серия.
 */
export function nextEpisode(
  groups: readonly PlayerEpisodeGroup[],
  mediaId: number,
): PlayerEpisode | null {
  const flat = flattenEpisodes(groups);
  const idx = flat.findIndex((e) => e.mediaId === mediaId);
  if (idx < 0 || idx + 1 >= flat.length) return null;
  return flat[idx + 1] ?? null;
}
