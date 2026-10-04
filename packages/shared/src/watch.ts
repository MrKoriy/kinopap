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
import type {
  HistoryEntryDto,
  ItemDetail,
  ItemProgressDto,
  ItemProgressEntry,
  Season,
} from "@zal/api-client";

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
  for (const ep of item.specials?.episodes ?? []) {
    if (ep.mediaId === mediaId) return `Спецвыпуск ${ep.number}`;
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

/* ---------- Выбор сезона по прогрессу ---------- */

/** Карта mediaId → запись прогресса: строки серий ищут себя одним проходом. */
export function progressByMedia(
  progress: Pick<ItemProgressDto, "entries"> | null | undefined,
): Map<number, ItemProgressEntry> {
  return new Map((progress?.entries ?? []).map((e) => [e.mediaId, e]));
}

/**
 * Последняя начатая серия: запись in_progress с самой свежей меткой updatedAt.
 * null — начатых нет. По ней карточка тайтла выбирает активный сезон и точку
 * возобновления.
 *
 * Метки сравниваются парсингом дат, а не лексикографически: у ISO-строк
 * порядок совпадает с хронологией, но парсинг честнее и переживает записи
 * в разных форматах. Запись с битой меткой не кандидат: веб раньше мог взять
 * именно её первой и застрять на ней — NaN не сравнивается ни с чем.
 */
export function latestInProgressEntry(
  progress: Pick<ItemProgressDto, "entries"> | null | undefined,
): ItemProgressEntry | null {
  let best: ItemProgressEntry | null = null;
  let bestAt = Number.NaN;
  for (const entry of progress?.entries ?? []) {
    if (entry.status !== "in_progress") continue;
    const at = Date.parse(entry.updatedAt);
    if (Number.isNaN(at)) continue;
    if (best == null || at > bestAt) {
      best = entry;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Сезон по умолчанию на карточке тайтла: где остановились, а не первый попавшийся.
 *
 * Правило сводит две написанные независимо копии. Мобильный клиент искал
 * сезон самой свежей начатой серии (сравнением ISO-строк) и возвращал id
 * сезона; веб брал последнюю начатую запись (Date.parse), отображал её в
 * индекс сезона и дополнительно открывал сезон точки возобновления, когда
 * начатых нет вовсе. Возврат — id сезона, как у мобильного: индекс — функция
 * того же списка, и платформа считает его сама (`seasonIndexForMedia` или
 * findIndex по id).
 *
 * Порядок правил: самая свежая начатая серия → сезон точки возобновления
 * (обычно это та же серия) → первый сезон. Точка возобновления может
 * указывать на досмотренную запись и всё равно выбрать свой сезон — это
 * поведение веба, и оно осознанно: «Продолжить» ведёт туда, где остановились.
 */
export function pickDefaultSeason(
  seasons: readonly Season[],
  progress: Pick<ItemProgressDto, "entries" | "resumeMediaId"> | null | undefined,
): number | null {
  if (seasons.length === 0) return null;
  if (progress) {
    const byMedia = progressByMedia(progress);
    let bestSeasonId: number | null = null;
    let bestAt = Number.NaN;
    for (const season of seasons) {
      for (const ep of season.episodes) {
        if (ep.mediaId == null) continue;
        const entry = byMedia.get(ep.mediaId);
        if (entry?.status !== "in_progress") continue;
        const at = Date.parse(entry.updatedAt);
        if (Number.isNaN(at)) continue;
        if (bestSeasonId == null || at > bestAt) {
          bestSeasonId = season.id;
          bestAt = at;
        }
      }
    }
    if (bestSeasonId != null) return bestSeasonId;
    if (progress.resumeMediaId != null) {
      const resumeSeason = seasons.find((s) =>
        s.episodes.some((e) => e.mediaId === progress.resumeMediaId),
      );
      if (resumeSeason) return resumeSeason.id;
    }
  }
  return seasons[0]!.id;
}

/**
 * Индекс сезона, которому принадлежит media. null — не нашли или seasons нет.
 * Веб-карточка открывает сезоны вкладками по индексу; мобильный клиент
 * идёт по id сезона из `pickDefaultSeason`.
 */
export function seasonIndexForMedia(
  item: Pick<ItemDetail, "seasons">,
  mediaId: number | null,
): number | null {
  if (mediaId == null || !item.seasons) return null;
  const idx = item.seasons.findIndex((s) => s.episodes.some((e) => e.mediaId === mediaId));
  return idx >= 0 ? idx : null;
}
