/**
 * Чистая логика карточки тайтла: какой сезон открыть по умолчанию, в каком
 * состоянии серия (начата/досмотрена), куда ведёт главная кнопка и когда
 * отправлять прогресс. Вынесено из экрана — так это покрывается тестами без
 * рендера и без сети.
 *
 * Правила слотов и подписей («S2E4», «Часть 2», «Продолжить S2E4») живут в
 * `@zal/shared`: они одинаковы у веба и мобильного, а написанные дважды успели
 * разойтись.
 */
import type {
  HistoryEntryDto,
  ItemDetail,
  ItemProgressDto,
  ItemProgressEntry,
  Season,
} from "@zal/api-client";
import { historyPositionLabel, primaryPlayLabel } from "@zal/shared";

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

export interface PrimaryPlay {
  mediaId: number;
  label: string;
}

/**
 * Главная кнопка карточки: куда ведёт и что на ней написано. Подпись считает
 * `@zal/shared` — правило общее с вебом.
 *
 * Здесь остаётся только выбор цели. Одночастевый фильм ведёт на свою
 * единственную часть, остальное — на точку возобновления, а без неё на первую
 * доступную серию.
 */
export function primaryPlay(
  item: ItemDetail,
  progress: ItemProgressDto | null,
): PrimaryPlay | null {
  const resumeMediaId = progress?.resumeMediaId ?? null;
  const target = resumeMediaId ?? firstPlayableMediaId(item);
  if (target == null) return null;
  return { mediaId: target, label: primaryPlayLabel(item, resumeMediaId) };
}

/**
 * Человекочитаемая строка записи истории: «S2E4 · Серия 4» для серий,
 * «Часть 2» для частей фильма, иначе — имя media или название тайтла.
 *
 * Отличие от веба только в этих двух параметрах: в списке истории мобильного
 * строка одна, поэтому у неё есть запасное название тайтла и подпись «Серия N»
 * для серии без своего имени. Веб и то и другое рисует рядом отдельно.
 */
export function historyLabel(entry: HistoryEntryDto): string {
  return historyPositionLabel(entry, {
    fallback: entry.itemTitle,
    episodeTitle: entry.episodeNumber != null ? `Серия ${entry.episodeNumber}` : null,
  });
}

/** Всё, что нужно, чтобы решить, отправлять ли позицию на сервер. */
export interface SaveDecision {
  /** Позиция из плеера, с. */
  position: number;
  /** Длительность, с; 0 — плеер её ещё не знает. */
  duration: number;
  /** Что отправили в прошлый раз. */
  lastSaved: number;
  /** Пауза, уход с экрана, смена серии: пишем, даже если позиция не сдвинулась. */
  force: boolean;
}

/**
 * Отправлять ли прогресс. Ловушка, ради которой это вынесено из экрана:
 * `player.replace()` обнуляет `currentTime` сразу, а длительность нового HLS
 * приходит только после разбора манифеста. На паузе и на уходе с экрана запись
 * принудительная, то есть обе нижние проверки пропускаются, — и в этот миг на
 * сервер уходил ноль, затирая точку возобновления, к которой мы сами же и
 * вернёмся. Заметнее всего на переключении дубляжа: источник меняется, `playing`
 * на миг падает в false, срабатывает запись на паузе.
 */
export function shouldSaveProgress(d: SaveDecision): boolean {
  // Без длительности запись бессмысленна: сервер посчитает ratio = 0, переведёт
  // серию в in_progress, а полоска прогресса поделит на ноль. Веб-плеер ровно
  // по этой же причине не пишет прогресс, пока не знает `video.duration`.
  if (d.duration <= 0) return false;
  if (d.force) return true;
  if (d.position < 5) return false;
  return Math.abs(d.position - d.lastSaved) >= 2;
}
