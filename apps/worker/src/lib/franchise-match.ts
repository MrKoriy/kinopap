/**
 * Матч частей франшизы AniList с карточками каталога — чистые функции.
 */

import type { FranchiseEntryInput, TitleIndexRow } from "@zal/db";
import { normTitle } from "@zal/db";
import { type AniMedia, aniTitles, aniYear } from "@zal/ingest";

export type TitleIndex = Map<string, TitleIndexRow[]>;

export function buildTitleIndex(rows: TitleIndexRow[]): TitleIndex {
  const idx: TitleIndex = new Map();
  for (const r of rows) {
    for (const t of new Set([normTitle(r.title), normTitle(r.originalTitle)])) {
      if (t.length < 2) continue;
      const list = idx.get(t);
      if (list) list.push(r);
      else idx.set(t, [r]);
    }
  }
  return idx;
}

/** Фильмы франшизы — карточки-фильмы, сезоны — сериалы/аниме: не путаем «Фильм» с ТВ. */
function typeFits(row: TitleIndexRow, m: AniMedia): boolean {
  if (m.format === "MOVIE") return row.type === "movie" || row.type === "anime";
  return row.type !== "movie";
}

/** Наша карточка для части: точное название + год ±1 + подходящий тип; популярнейшая. */
export function matchEntry(idx: TitleIndex, m: AniMedia): TitleIndexRow | null {
  const year = aniYear(m);
  const seen = new Set<number>();
  const hits: TitleIndexRow[] = [];
  for (const t of aniTitles(m)) {
    for (const r of idx.get(normTitle(t)) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (year != null && r.year != null && Math.abs(r.year - year) > 1) continue;
      if (!typeFits(r, m)) continue;
      hits.push(r);
    }
  }
  hits.sort((a, b) => b.views - a.views || a.id - b.id);
  return hits[0] ?? null;
}

/**
 * Строки franchise_entries: части по порядку, у каждой — наша карточка или
 * null. Стартовый тайтл (по нему искали) привязывается к своей части
 * гарантированно — даже если его русское название AniList не знает.
 */
export function buildEntries(
  ordered: AniMedia[],
  idx: TitleIndex,
  seed: { anilistId: number; itemId: number; title: string },
): FranchiseEntryInput[] {
  const seedNode = ordered.find((m) => m.id === seed.anilistId);
  const seedNames = seedNode ? aniTitles(seedNode).map(normTitle).filter((n) => n.length >= 4) : [];
  // «Shingeki no Kyojin Season 2» без своей карточки — это сезон той же
  // карточки (TMDb держит все сезоны в одном тайтле): ведём на неё.
  const isSeedSeason = (m: AniMedia) =>
    (m.format === "TV" || m.format === "TV_SHORT") &&
    aniTitles(m).some((t) => seedNames.some((n) => normTitle(t).startsWith(n)));
  return ordered.map((m) => {
    const row = m.id === seed.anilistId ? null : matchEntry(idx, m);
    const itemId =
      m.id === seed.anilistId ? seed.itemId : (row?.id ?? (isSeedSeason(m) ? seed.itemId : null));
    const title =
      m.id === seed.anilistId ? seed.title : (row?.title ?? m.title.english ?? m.title.romaji ?? m.title.native ?? `#${m.id}`);
    return {
      anilistId: m.id,
      title,
      format: m.format ?? null,
      year: aniYear(m),
      episodes: m.episodes ?? null,
      itemId,
    };
  });
}

/** Название франшизы: первая сматченная ТВ-часть, иначе первая часть. */
export function franchiseTitle(entries: FranchiseEntryInput[]): string {
  const tv = entries.find((e) => e.itemId != null && (e.format === "TV" || e.format === "TV_SHORT"));
  return (tv ?? entries.find((e) => e.itemId != null) ?? entries[0])?.title ?? "Франшиза";
}
