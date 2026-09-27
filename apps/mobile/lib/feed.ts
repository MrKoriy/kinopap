/**
 * Чистые помощники ленты «новое по подпискам»: подписи строк
 * для серий (S1E2) и новых частей фильмов (Часть 2).
 */
import type { NewEpisodeDto } from "@zal/api-client";

type FeedShape = Pick<
  NewEpisodeDto,
  "kind" | "seasonNumber" | "episodeNumber" | "partNumber"
>;

/** Короткая метка: "S1E2" для серии, "Часть 2" для новой части фильма. */
export function feedLabel(ep: FeedShape): string {
  if (ep.kind === "part") return `Часть ${ep.partNumber ?? "?"}`;
  return `S${ep.seasonNumber ?? "?"}E${ep.episodeNumber ?? "?"}`;
}

type FeedTitle = Pick<NewEpisodeDto, "kind" | "itemTitle" | "episodeTitle" | "title">;

/** Полная строка: «Тайтл — Серия» / «Тайтл — Часть». */
export function feedTitle(ep: FeedTitle): string {
  const extra =
    ep.kind === "episode" ? (ep.episodeTitle ?? "") : (ep.title ?? "");
  return extra ? `${ep.itemTitle} — ${extra}` : ep.itemTitle;
}
