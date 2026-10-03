/**
 * Раскладка длинных сезонов по эпизод-группам TMDb.
 *
 * «Блич» у AniLibria — один релиз на 354 серии, у TMDb — «Сезон 1» на 366.
 * Листать такое невозможно, а «следующий сезон» не существует. У TMDb для
 * таких шоу есть эпизод-группы (TVDB Order, Season Split, Story Arcs) —
 * выбираем самую «сезонную» и раскладываем серии по ней. Нет групп —
 * данные не трогаем, длинный сезон UI режет на диапазоны «1–50, 51–100».
 */
import { applySeasonLayout, type Db, flatEpisodes, items, longestSeason } from "@zal/db";
import { eq } from "drizzle-orm";
import type { Config } from "../config";
import { tmdbGet } from "./tmdb";

/** Сезон длиннее — кандидат на перестройку. Обычные сезоны (≤ 70) не трогаем. */
export const LONG_SEASON = 70;
/** Группа длиннее — раскладка бесполезна (тот же «Сезон 1» другими словами). */
const MAX_GROUP = 150;
/** Средний сезон короче — это DVD-диски/недели/сегменты, а не сезоны. */
const MIN_AVG_GROUP = 8;

interface GroupSummary {
  id: string;
  type: number;
  name: string;
  group_count: number;
  episode_count: number;
}

interface GroupDetail {
  groups?: Array<{
    name?: string;
    order?: number;
    episodes?: Array<{ season_number?: number; episode_number?: number; order?: number }>;
  }>;
}

export interface TmdbLayout {
  id: string;
  name: string;
  groups: Array<{ title: string | null; eps: Array<[number, number]> }>;
}

/** Предпочтение типов TMDb: production → original air → TV → digital → arcs → DVD. */
const TYPE_RANK: Record<number, number> = { 6: 0, 1: 1, 7: 2, 4: 3, 5: 4, 3: 5 };
const SEASONISH = /season|сезон|split|tvdb|aired|production/i;
/** Неполные/чужие порядки: без филлеров, Kai, выборки стримингов, дубляжи. */
const PARTIAL = /special|thematic|theme|segment|week|спецв|filler|kai|kaï|netflix|selection|chapter|bilibili|china|chinese|dub|travel/i;

/** Русское имя группы или null (UI подпишет «Сезон N»): английские арки в русском UI — шум. */
function ruTitle(name: string | undefined): string | null {
  const t = (name ?? "").trim();
  if (!t || !/[а-яё]/i.test(t)) return null;
  if (/^(сезон|часть)\s*\d+$/i.test(t)) return null;
  return t.slice(0, 255);
}

const byOrder = <T extends { order?: number }>(a: T, b: T) => (a.order ?? 0) - (b.order ?? 0);

export async function pickEpisodeGroupLayout(
  config: Config,
  tmdbId: number,
  total: number,
): Promise<TmdbLayout | null> {
  const list = await tmdbGet<{ results?: GroupSummary[] }>(config, `/tv/${tmdbId}/episode_groups`);
  // Сбой запроса ≠ «групп нет»: иначе транзиентная ошибка навсегда пометила бы тайтл.
  if (!list) throw new Error(`tmdb: episode_groups ${tmdbId} unavailable`);
  const seasonish = (g: GroupSummary) => (SEASONISH.test(g.name) ? 0 : 1);
  const candidates = (list?.results ?? [])
    .filter(
      (g) =>
        TYPE_RANK[g.type] != null &&
        g.group_count >= 2 &&
        g.episode_count >= total * 0.9 &&
        g.episode_count <= total * 1.4 &&
        !PARTIAL.test(g.name),
    )
    .sort(
      (a, b) =>
        seasonish(a) - seasonish(b) ||
        TYPE_RANK[a.type]! - TYPE_RANK[b.type]! ||
        Math.abs(a.episode_count - total) - Math.abs(b.episode_count - total),
    );

  for (const c of candidates.slice(0, 4)) {
    const detail = await tmdbGet<GroupDetail>(config, `/tv/episode_group/${c.id}`);
    const groups = (detail?.groups ?? [])
      .slice()
      .sort(byOrder)
      .map((g) => ({
        title: ruTitle(g.name),
        eps: (g.episodes ?? [])
          .filter((e) => Number(e.season_number) > 0 && Number(e.episode_number) > 0)
          .sort(byOrder)
          .map((e) => [Number(e.season_number), Number(e.episode_number)] as [number, number]),
      }))
      .filter((g) => g.eps.length > 0);
    if (groups.length < 2) continue;
    if (Math.max(...groups.map((g) => g.eps.length)) > MAX_GROUP) continue;
    const covered = groups.reduce((n, g) => n + g.eps.length, 0);
    if (covered / groups.length < MIN_AVG_GROUP) continue;
    return { id: c.id, name: c.name, groups };
  }
  return null;
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, "");

/** TMDb-id аниме без tmdb_id (релизы AniLibria): поиск по названию, только анимация. */
async function findTmdbAnimeId(config: Config, names: Array<string | null>): Promise<number | null> {
  const wanted = new Set(names.map(norm).filter((n) => n.length >= 3));
  for (const q of names) {
    if (!q) continue;
    const res = await tmdbGet<{
      results?: Array<{ id: number; name?: string; original_name?: string; genre_ids?: number[] }>;
    }>(config, `/search/tv?query=${encodeURIComponent(q)}`);
    const hit = (res?.results ?? []).find(
      (r) => (r.genre_ids ?? []).includes(16) && (wanted.has(norm(r.name)) || wanted.has(norm(r.original_name))),
    );
    if (hit) return hit.id;
  }
  return null;
}

export type RegroupStatus =
  | "regrouped"
  | "already"
  | "short"
  | "no-tmdb"
  | "no-groups"
  | "low-coverage"
  | "missing";

/**
 * Перестраивает сезоны тайтла, если в нём есть сезон длиннее LONG_SEASON и
 * у TMDb нашлась подходящая эпизод-группа. Идемпотентно: перестроенный
 * тайтл (season_layout задан) повторно не трогается.
 */
export async function regroupLongSeasons(
  db: Db,
  config: Config,
  itemId: number,
  opts: { dryRun?: boolean } = {},
): Promise<{ status: RegroupStatus; seasons?: number; layout?: string }> {
  const [it] = await db
    .select({
      tmdbId: items.tmdbId,
      layout: items.seasonLayout,
      title: items.title,
      originalTitle: items.originalTitle,
    })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (!it) return { status: "missing" };
  if (it.layout) return { status: "already" };
  if ((await longestSeason(db, itemId)) <= LONG_SEASON) return { status: "short" };

  // Раскладки нет — помечаем «как у источника», чтобы фоновый догон не
  // переспрашивал TMDb об этом тайтле каждый час. Новые серии таких тайтлов
  // импорт кладёт как обычно (append только для tmdb-group:*).
  const keepSource = async (status: RegroupStatus) => {
    if (!opts.dryRun) {
      await db.update(items).set({ seasonLayout: "source" }).where(eq(items.id, itemId));
    }
    return { status };
  };

  const flat = await flatEpisodes(db, itemId);
  // У AniLibria серии — сквозные ordinal'ы «1/N», у TMDb — свои S/E.
  const byOrdinal = !it.tmdbId;
  const tmdbId = it.tmdbId ?? (await findTmdbAnimeId(config, [it.originalTitle, it.title]));
  if (!tmdbId) return keepSource("no-tmdb");

  const layout = await pickEpisodeGroupLayout(config, tmdbId, flat.length);
  if (!layout) return keepSource("no-groups");

  const keyToId = new Map<string, number>();
  if (!byOrdinal) {
    for (const e of flat) keyToId.set(`${e.origSeason}:${e.origNumber}`, e.id);
  } else {
    // Сквозной ordinal k ↔ k-я серия основных сезонов TMDb по порядку.
    const show = await tmdbGet<{ seasons?: Array<{ season_number: number; episode_count: number }> }>(
      config,
      `/tv/${tmdbId}`,
    );
    const coords: Array<[number, number]> = [];
    for (const s of (show?.seasons ?? []).filter((x) => x.season_number > 0).sort((a, b) => a.season_number - b.season_number)) {
      for (let e = 1; e <= s.episode_count; e++) coords.push([s.season_number, e]);
    }
    if (coords.length === 0 || flat.length > coords.length * 1.1) return keepSource("low-coverage");
    for (const e of flat) {
      const c = e.origSeason === 1 ? coords[e.origNumber - 1] : undefined;
      if (c) keyToId.set(`${c[0]}:${c[1]}`, e.id);
    }
  }

  const groups = layout.groups.map((g) => ({
    title: g.title,
    episodeIds: g.eps.map(([s, e]) => keyToId.get(`${s}:${e}`)).filter((id): id is number => id != null),
  }));
  const matched = groups.reduce((n, g) => n + g.episodeIds.length, 0);
  if (matched < flat.length * 0.85) return keepSource("low-coverage");
  // У нас часть серий (ongoing, неполная заливка) — средний сезон считаем по нашим.
  const filled = groups.filter((g) => g.episodeIds.length > 0).length;
  if (filled < 2 || matched / filled < MIN_AVG_GROUP) return keepSource("no-groups");

  const name = `tmdb-group:${layout.id}`;
  if (opts.dryRun) {
    return { status: "regrouped", seasons: groups.filter((g) => g.episodeIds.length).length, layout: `${layout.name} (${name}) [dry]` };
  }
  const res = await applySeasonLayout(db, itemId, name, groups);
  return { status: "regrouped", seasons: res.seasons, layout: `${layout.name} (${name})` };
}
