/**
 * Чистая логика карточки тайтла: какой сезон открыть по умолчанию, в каком
 * состоянии серия (начата/досмотрена) и куда ведёт главная кнопка. Вынесено
 * из экрана — так это покрывается тестами без рендера и без сети.
 */
import type {
  HistoryEntryDto,
  ItemDetail,
  ItemProgressDto,
  ItemProgressEntry,
  Season,
} from "@zal/api-client";

/** Состояние серии: ничего, начата (полоска) или досмотрена (галочка). */
export type WatchState =
  | { kind: "none" }
  | { kind: "progress"; progress: number }
  | { kind: "done" };

/** Состояние серии по записи прогресса. */
export function watchStateOf(entry: ItemProgressEntry | null | undefined): WatchState {
  if (!entry) return { kind: "none" };
  // "watched" — это и есть досмотрено; API не отдаёт отдельного boolean.
  if (entry.status === "watched") return { kind: "done" };
  if (entry.progress > 0) return { kind: "progress", progress: Math.min(1, entry.progress) };
  return { kind: "none" };
}

/** Карта mediaId → запись прогресса: строки серий ищут себя одним проходом. */
export function progressByMedia(
  progress: ItemProgressDto | null,
): Map<number, ItemProgressEntry> {
  return new Map((progress?.entries ?? []).map((e) => [e.mediaId, e]));
}

/**
 * Сезон по умолчанию: с самой свежей начатой серией, иначе — первый.
 * Так после перерыва карточка открывается там, где пользователь остановился.
 */
export function pickDefaultSeason(
  seasons: Season[],
  progress: ItemProgressDto | null,
): number | null {
  if (seasons.length === 0) return null;
  if (progress) {
    const byMedia = progressByMedia(progress);
    let bestSeasonId: number | null = null;
    let bestAt = "";
    for (const season of seasons) {
      for (const ep of season.episodes) {
        if (ep.mediaId == null) continue;
        const entry = byMedia.get(ep.mediaId);
        if (entry?.status !== "in_progress") continue;
        // updatedAt — ISO-строка, лексикографически совпадает с порядком дат.
        if (entry.updatedAt > bestAt) {
          bestAt = entry.updatedAt;
          bestSeasonId = season.id;
        }
      }
    }
    if (bestSeasonId != null) return bestSeasonId;
  }
  return seasons[0]!.id;
}

/** Первая серия/часть с файлом — цель кнопки «Смотреть» без прогресса. */
export function firstPlayableMediaId(item: ItemDetail): number | null {
  for (const season of item.seasons ?? []) {
    for (const ep of season.episodes) {
      if (ep.mediaId != null) return ep.mediaId;
    }
  }
  const firstPart = (item.media ?? [])[0];
  return firstPart ? firstPart.id : null;
}

/** Подпись media в терминах сериала: "S2E4" / "Часть 2"; null — не нашли. */
export function mediaLabel(item: ItemDetail, mediaId: number): string | null {
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

export interface PrimaryPlay {
  mediaId: number;
  label: string;
}

/**
 * Главная кнопка карточки. Одночастевый фильм — всегда «Смотреть»: его
 * позицию восстанавливает сам плеер, отдельная надпись тут не нужна.
 * Сериал и многочастевый фильм — «Продолжить S2E4» по resumeMediaId, иначе
 * «Смотреть» с первой доступной серии.
 */
export function primaryPlay(
  item: ItemDetail,
  progress: ItemProgressDto | null,
): PrimaryPlay | null {
  const single = item.media?.length === 1 ? item.media[0] : null;
  if (single) return { mediaId: single.id, label: "Смотреть" };

  if (progress?.resumeMediaId != null) {
    const label = mediaLabel(item, progress.resumeMediaId);
    return {
      mediaId: progress.resumeMediaId,
      label: label ? `Продолжить ${label}` : "Продолжить",
    };
  }
  const first = firstPlayableMediaId(item);
  return first != null ? { mediaId: first, label: "Смотреть" } : null;
}

/**
 * Человекочитаемая строка записи истории: «S2E4 · Серия 4» для серий,
 * «Часть 2» для частей фильма, иначе — имя media или название тайтла.
 */
export function historyLabel(entry: HistoryEntryDto): string {
  if (entry.seasonNumber != null && entry.episodeNumber != null) {
    const base = `S${entry.seasonNumber}E${entry.episodeNumber}`;
    return `${base} · ${entry.mediaTitle ?? `Серия ${entry.episodeNumber}`}`;
  }
  if (entry.partNumber != null) {
    const base = `Часть ${entry.partNumber}`;
    return entry.mediaTitle ? `${base} · ${entry.mediaTitle}` : base;
  }
  return entry.mediaTitle ?? entry.itemTitle;
}
