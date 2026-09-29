/**
 * Серии тайтла для плеера: группы, плоский порядок, «следующая серия».
 *
 * Логика жила в apps/web/lib/player-logic.ts, а мобильный клиент
 * reimplement'ил её инлайн в watch-экране — два порядка воспроизведения
 * могли разъехаться. Теперь один источник: порядок в меню и порядок
 * «следующая серия» совпадают на обоих клиентах.
 */
import type { ItemDetail } from "@zal/api-client";

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
