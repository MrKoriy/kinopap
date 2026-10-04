/**
 * AniList GraphQL: франшизы аниме по связям PREQUEL/SEQUEL/SIDE_STORY/…
 *
 * Лимит AniList — 90 запросов в минуту (в деградации бывает 30): клиент
 * держит ровный темп (по умолчанию 1 запрос в 0.8 с) и на 429 ждёт
 * Retry-After. Граф обходится уровнями: все соседи уровня — одним запросом
 * `Page { media(id_in: [...]) }`, а не по запросу на узел.
 */
import { fetchWithTimeout } from "./lib/http";

export const ANILIST_URL = "https://graphql.anilist.co";

/** Связи, которые держат части одной франшизы. CHARACTER/OTHER/ADAPTATION — мимо. */
export const FRANCHISE_RELATIONS = new Set(["PREQUEL", "SEQUEL", "SIDE_STORY", "PARENT", "SPIN_OFF", "SUMMARY", "ALTERNATIVE"]);
/** Рёбра, по которым идём дальше (spin-off/alternative — показываем, но не раскручиваем). */
const WALK_RELATIONS = new Set(["PREQUEL", "SEQUEL", "SIDE_STORY", "PARENT"]);
/** Потолок частей: у «Гандама» и «Покемона» графы на сотни узлов. */
const MAX_NODES = 40;

export interface AniMedia {
  id: number;
  title: { romaji?: string | null; english?: string | null; native?: string | null };
  synonyms?: string[] | null;
  format?: string | null;
  type?: string | null;
  episodes?: number | null;
  seasonYear?: number | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  relations?: { edges?: Array<{ relationType?: string | null; node?: { id: number; type?: string | null } | null }> } | null;
}

const MEDIA_FIELDS = `
  id title { romaji english native } synonyms format type episodes seasonYear
  startDate { year month day }
  relations { edges { relationType node { id type } } }
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AniListClientOptions {
  fetch?: typeof fetch;
  /** Пауза между запросами; 800 мс ≈ 75/мин — с запасом от 90. */
  intervalMs?: number;
  url?: string;
}

export class AniListClient {
  private nextAt = 0;
  private readonly fetchFn: typeof fetch;
  private readonly intervalMs: number;
  private readonly url: string;
  requests = 0;

  constructor(opts: AniListClientOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.intervalMs = opts.intervalMs ?? 800;
    this.url = opts.url ?? ANILIST_URL;
  }

  async query<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = Date.now();
      const start = Math.max(now, this.nextAt);
      this.nextAt = start + this.intervalMs;
      if (start > now) await sleep(start - now);
      this.requests++;
      let res: Response;
      try {
        res = await fetchWithTimeout(this.url, 15_000, {
          fetchImpl: this.fetchFn,
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query, variables }),
        });
      } catch {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.status === 429) {
        // Retry-After в секундах; без него — минута (окно лимита AniList).
        const ra = res.headers.get("retry-after");
        const wait = ra && Number.isFinite(Number(ra)) ? Number(ra) : 60;
        this.nextAt = Date.now() + wait * 1000;
        continue;
      }
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: T };
      return body.data ?? null;
    }
    return null;
  }

  /** Поиск аниме по названию: несколько кандидатов, выбор — на вызывающем. */
  async search(title: string): Promise<AniMedia[]> {
    const data = await this.query<{ Page?: { media?: AniMedia[] } }>(
      `query ($q: String) { Page(perPage: 6) { media(search: $q, type: ANIME) { ${MEDIA_FIELDS} } } }`,
      { q: title },
    );
    return data?.Page?.media ?? [];
  }

  async byIds(ids: number[]): Promise<AniMedia[]> {
    if (ids.length === 0) return [];
    const data = await this.query<{ Page?: { media?: AniMedia[] } }>(
      `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } } }`,
      { ids },
    );
    return data?.Page?.media ?? [];
  }

  /**
   * Вся франшиза от стартового узла: BFS по уровням (один запрос на уровень).
   * Стартовый узел уже загружен поиском — его соседей берём из него же.
   */
  async franchise(seed: AniMedia): Promise<AniMedia[]> {
    const nodes = new Map<number, AniMedia>([[seed.id, seed]]);
    let frontier = neighbours(seed).filter((id) => !nodes.has(id));
    while (frontier.length > 0 && nodes.size < MAX_NODES) {
      const batch = frontier.slice(0, MAX_NODES - nodes.size);
      const loaded = await this.byIds(batch);
      if (loaded.length === 0) break;
      const next: number[] = [];
      for (const m of loaded) {
        if (nodes.has(m.id)) continue;
        nodes.set(m.id, m);
        if (isWalkable(m)) next.push(...neighbours(m));
      }
      frontier = [...new Set(next)].filter((id) => !nodes.has(id));
    }
    return [...nodes.values()];
  }
}

/** Музыкальные клипы и «рекапы» не ведут дальше: через них граф склеивает чужие вселенные. */
function isWalkable(m: AniMedia): boolean {
  return m.format !== "MUSIC";
}

/** Соседи по рёбрам франшизы (только аниме). */
export function neighbours(m: AniMedia): number[] {
  return (m.relations?.edges ?? [])
    .filter((e) => e.node && e.node.type !== "MANGA" && e.node.type !== "NOVEL" && WALK_RELATIONS.has(e.relationType ?? ""))
    .map((e) => e.node!.id);
}

const dateKey = (m: AniMedia) =>
  (m.startDate?.year ?? m.seasonYear ?? 9999) * 10_000 + (m.startDate?.month ?? 12) * 100 + (m.startDate?.day ?? 31);

/** Части по порядку выхода; при равной дате — TV раньше фильмов и OVA. */
const FORMAT_RANK: Record<string, number> = { TV: 0, TV_SHORT: 1, ONA: 2, MOVIE: 3, OVA: 4, SPECIAL: 5, MUSIC: 9 };
export function orderFranchise(nodes: AniMedia[]): AniMedia[] {
  return nodes
    .filter((m) => m.type !== "MANGA" && m.format !== "MUSIC")
    .slice()
    .sort((a, b) => dateKey(a) - dateKey(b) || (FORMAT_RANK[a.format ?? ""] ?? 6) - (FORMAT_RANK[b.format ?? ""] ?? 6) || a.id - b.id);
}

export function aniTitles(m: AniMedia): string[] {
  return [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms ?? [])].filter(
    (t): t is string => !!t && t.trim().length > 0,
  );
}

export const aniYear = (m: AniMedia): number | null => m.startDate?.year ?? m.seasonYear ?? null;

const norm = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Лучший кандидат поиска для нашего тайтла: точное совпадение одного из
 * названий и год ±1. Без совпадения названия — null (поиск AniList нечёткий,
 * «первый результат» на русских запросах — лотерея).
 */
export function pickSearchHit(
  hits: AniMedia[],
  wanted: { titles: Array<string | null | undefined>; year: number | null },
): AniMedia | null {
  const names = new Set(wanted.titles.map(norm).filter((n) => n.length >= 2));
  const scored = hits
    .map((h) => {
      const titleHit = aniTitles(h).some((t) => names.has(norm(t)));
      const y = aniYear(h);
      const yearOk = wanted.year == null || y == null || Math.abs(y - wanted.year) <= 1;
      return { h, ok: titleHit && yearOk, exactYear: y != null && y === wanted.year };
    })
    .filter((x) => x.ok)
    .sort((a, b) => Number(b.exactYear) - Number(a.exactYear));
  return scored[0]?.h ?? null;
}

/** Ключ франшизы: минимальный id компоненты — стабилен из любой точки графа. */
export const franchiseRootId = (nodes: AniMedia[]) => Math.min(...nodes.map((n) => n.id));
