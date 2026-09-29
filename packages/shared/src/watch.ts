/**
 * Правила «что и откуда смотреть» — общие для веб-клиента и мобильного.
 *
 * Лежат в пакете, а не в каждом клиенте, потому что это правила предметной
 * области, а не вёрстки: «S2E4», «Часть 2», «Продолжить S2E4». Написаны они
 * были дважды, и подписи успели разойтись: веб для многочастевого фильма
 * показывал «Продолжить» там, где мобильный показывал «Продолжить Часть 2».
 * Расхождение тут — не стиль, а ошибка: слот media у тайтла один и тот же.
 *
 * Где клиенты расходятся осознанно, это видно в сигнатурах (`opts`), а не
 * спрятано внутри.
 */
import type { HistoryEntryDto, ItemDetail } from "@zal/api-client";

/**
 * Как тайтл называет этот media: «S2E4» у серии, «Часть 2» у части фильма.
 * `null` — media в дереве тайтла нет: данные разъехались либо id чужой.
 *
 * Части проверяются после серий намеренно: у аниме без сезонов `seasons` пуст,
 * а контент приходит частями в `media`, и обратный порядок ничего не сломал бы,
 * но именно этот порядок совпадает с тем, как тайтл показывает список.
 */
export function mediaSlotLabel(item: ItemDetail, mediaId: number | null): string | null {
  if (mediaId == null) return null;
  for (const season of item.seasons ?? []) {
    for (const ep of season.episodes) {
      if (ep.mediaId === mediaId) return `S${season.number}E${ep.number}`;
    }
  }
  for (const part of item.media ?? []) {
    if (part.id === mediaId) return `Часть ${part.partNumber}`;
  }
  return null;
}

/**
 * Подпись главной кнопки тайтла: «Смотреть» / «Продолжить S2E4» /
 * «Продолжить Часть 2» / «Продолжить».
 *
 * Без `resumeMediaId` — «Смотреть». С ним подпись уточняется слотом, если слот
 * известен; «Продолжить» без уточнения остаётся на случай, когда серия не
 * нашлась в дереве тайтла — лучше не обещать ничего, чем обещать не то.
 *
 * Одночастевый фильм — всегда «Смотреть», даже когда точка возобновления есть.
 * Две причины. Позицию восстанавливает сам плеер, так что «Продолжить» ничего
 * не добавляет к поведению. И `mediaSlotLabel` для единственной части честно
 * возвращает «Часть 1» — подпись «Продолжить Часть 1» у фильма, у которого
 * частей нет, читалась бы как издевательство.
 *
 * Раньше это правило было только у мобильного клиента, а веб считал подпись
 * сам и на многочастевом фильме писал «Продолжить» вместо «Продолжить Часть 2».
 * Держать такое в клиенте — значит гарантированно разойтись снова.
 */
export function primaryPlayLabel(item: ItemDetail, resumeMediaId: number | null): string {
  if (item.media?.length === 1) return "Смотреть";
  if (resumeMediaId == null) return "Смотреть";
  const slot = mediaSlotLabel(item, resumeMediaId);
  return slot ? `Продолжить ${slot}` : "Продолжить";
}

/** Код слота для записи истории: «S2E4» / «Часть 2». `null` — уточнять нечего. */
export function historySlotCode(
  entry: Pick<HistoryEntryDto, "seasonNumber" | "episodeNumber" | "partNumber">,
): string | null {
  if (entry.seasonNumber != null && entry.episodeNumber != null) {
    return `S${entry.seasonNumber}E${entry.episodeNumber}`;
  }
  if (entry.partNumber != null) return `Часть ${entry.partNumber}`;
  return null;
}

/**
 * Подпись позиции в истории: «S2E4 · Серия 4», «Часть 2», название media.
 *
 * Два параметра — это два места, где клиенты расходятся по вёрстке и по копии,
 * и оба принадлежат вызывающему, а не правилу:
 *
 * - `fallback` — что вернуть, когда нет ни слота, ни названия media. Веб рисует
 *   название тайтла отдельной строкой и оставляет `""`; мобильный показывает
 *   ровно эту строку и передаёт название тайтла.
 * - `episodeTitle` — чем подписать серию без своего названия. Веб оставляет
 *   «S2E4», мобильный дописывает «Серия 4».
 */
export function historyPositionLabel(
  entry: Pick<HistoryEntryDto, "seasonNumber" | "episodeNumber" | "partNumber" | "mediaTitle">,
  opts: { fallback?: string; episodeTitle?: string | null } = {},
): string {
  const code = historySlotCode(entry);
  if (code == null) return entry.mediaTitle ?? opts.fallback ?? "";
  const title = entry.mediaTitle ?? opts.episodeTitle ?? null;
  return title ? `${code} · ${title}` : code;
}
