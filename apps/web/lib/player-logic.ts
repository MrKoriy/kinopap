/**
 * Чистая логика плеера без DOM: спрайты и интро.
 * WebVTT-парсер, активные реплики и серии/эпизоды живут в @zal/shared
 * (одинаковы для веба и мобилы), здесь — только реэкспорт для обратной
 * совместимости импортов.
 */
import type { MediaFile } from "@zal/api-client";

export {
  activeCues,
  cueAt,
  episodeGroups,
  flattenEpisodes,
  nextEpisode,
  type PlayerEpisode,
  type PlayerEpisodeGroup,
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

/* ---------- Буфер воспроизведения ---------- */

/** Отрезок буфера в долях длительности: 0 — начало, 1 — конец. */
export interface BufferedSegment {
  start: number;
  end: number;
}

/**
 * Готовые к отрисовке отрезки буфера.
 *
 * На вход идут пары в секундах, а не сам `TimeRanges`: это живой объект,
 * который браузер меняет под нами, и в `useState` его класть нельзя — к
 * моменту рендера в нём уже другие числа. Снимок делает вызывающий.
 *
 * Ноль отрезков и отрезок нулевой длины — не одно и то же, и оба законны.
 * Первое значит «ни один фрагмент ещё не пришёл» (сразу после `load()`),
 * второе — «дырка в буфере»; и то и другое должно дать пустую полосу, а не
 * отрицательной ширины прямоугольник. Поэтому нулевые отрезки отбрасываются,
 * а не зажимаются в точку.
 *
 * Доли зажимаются в [0,1] и считаются только при конечной положительной
 * длительности: у прямого потока `duration` бывает 0 или Infinity, и без этой
 * проверки ширина уехала бы в NaN или бесконечность.
 *
 * Соседние отрезки склеиваются. `buffered` у hls.js после перескока по
 * скрабберу даёт рваный список, а два прямоугольника встык рисуются как один,
 * но дают лишний узел и волосяной шов на стыке.
 */
export function bufferedSegments(
  ranges: readonly { start: number; end: number }[],
  duration: number,
): BufferedSegment[] {
  if (!(duration > 0) || !Number.isFinite(duration)) return [];

  const clamped: BufferedSegment[] = [];
  for (const r of ranges) {
    const start = Math.max(0, Math.min(1, r.start / duration));
    const end = Math.max(0, Math.min(1, r.end / duration));
    if (end <= start) continue;
    clamped.push({ start, end });
  }
  // Порядок берём свой: функция чистая и не вправе полагаться на то, что
  // вызывающий отсортировал. У `TimeRanges` порядок гарантирован, у снимка
  // из отладочного инструмента — уже нет.
  clamped.sort((a, b) => a.start - b.start);

  const out: BufferedSegment[] = [];
  for (const seg of clamped) {
    const last = out[out.length - 1];
    if (last && seg.start <= last.end) {
      if (seg.end > last.end) last.end = seg.end;
      continue;
    }
    out.push({ ...seg });
  }
  return out;
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

/* ---------- Адрес потока ---------- */

/**
 * Адрес, который отдаём в `<video>` или hls.js.
 *
 * Три слоя выбора, и порядок между ними неочевиден:
 * — `directFallback` (gst не собрал манифест) — прямой HTTP;
 * — дубляж с `masterUrl` (zero-storage: gst выбирает аудио параметром URL) —
 *   персональный мастер важнее базового;
 * — базовый: HLS, иначе прямой.
 *
 * Сравнения здесь `||`, а не `??`, и это не стилистика. Репозиторий отдаёт
 * `http: mediaUrl(...) ?? ""` — пустая строка означает «у файла нет ключа», а
 * не «адрес». С `??` она прошла бы насквозь и стала бы адресом потока: эффект
 * инициализации выходит по `!streamUrl`, и пользователь получил бы чёрный
 * прямоугольник без ошибки и без спиннера — худший вид отказа. С `||` пустая
 * строка проваливается к следующему слою, и раздача идёт обычным путём:
 * ошибка, перебор, сообщение.
 *
 * `audioMaster` приходит снаружи уже с поправкой на «нулевая дорожка — это
 * базовый мастер»: у ингест-тайтлов дорожке с индексом 0 соответствует общий
 * манифест, а не отдельная.
 */
export function resolveStreamUrl({
  file,
  directFallback,
  audioMaster,
}: {
  file: Pick<MediaFile, "urls"> | undefined;
  directFallback: boolean;
  audioMaster: string | null | undefined;
}): string | null {
  const base = file?.urls.hls || file?.urls.http || null;
  if (directFallback) return file?.urls.http || base;
  return audioMaster || base;
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

/**
 * Ссылки запуска в IINA/VLC. Конструировались в двух местах (оверлей ошибки
 * плеера и панель на watch-странице) и уже разъехались в экранировании —
 * теперь один источник.
 */
export function externalPlayerLinks(url: string): { iina: string; vlc: string } {
  return {
    iina: `iina://weblink?url=${encodeURIComponent(url)}`,
    vlc: `vlc://${url}`,
  };
}

/* ---------- Серии: общие с мобильным клиентом, см. @zal/shared ---------- */
