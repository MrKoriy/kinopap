/**
 * Чистая логика плеера без DOM: спрайты и интро.
 * WebVTT-парсер и активные реплики живут в @zal/shared (одинаковы для
 * веба и мобилы), здесь — только реэкспорт для обратной совместимости.
 */
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
