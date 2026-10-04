/**
 * Онлайн-балансеры (Kodik, Alloha): готовые HLS-плееры в iframe.
 *
 * Зачем: торрент до первого кадра — это поиск раздачи, пиры и буфер, на
 * холодную десятки секунд. Балансер отдаёт плеер со своего CDN за 1–2 с.
 * Плеер чужой, поэтому это второй источник рядом с торрентом, а не замена:
 * пропуск заставок, Chromecast и точный прогресс там не наши.
 *
 * Матчинг строгий: по IMDb/Кинопоиску; поиск по названию — только с годом
 * и совпадением типа (фильм/сериал), иначе легко отдать чужой тайтл.
 */

export type OnlineProvider = "kodik" | "alloha";

export interface OnlineSource {
  provider: OnlineProvider;
  /** Подпись в переключателе: озвучка или имя балансера. */
  label: string;
  url: string;
  quality: string | null;
  /** Номер последнего доступного сезона/серии (сериалы), если балансер знает. */
  lastSeason: number | null;
  lastEpisode: number | null;
}

export interface OnlineTarget {
  /** Тип каталога (movie, serial, anime, docuserial, …). */
  type: string;
  tmdbId: number | null;
  tmdbType: string | null;
  imdbId: number | null;
  kinopoiskId: number | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
}

export interface BalancerConfig {
  kodikToken?: string;
  /** Kodik переезжает между доменами (kodikapi.com уже не резолвится). */
  kodikApiUrl?: string;
  allohaToken?: string;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const TIMEOUT_MS = 6000;

export function imdbTag(id: number): string {
  return `tt${String(id).padStart(7, "0")}`;
}

export function parseImdbTag(tag: unknown): number | null {
  if (typeof tag !== "string") return null;
  const m = /^tt(\d{5,10})$/.exec(tag.trim());
  return m ? Number(m[1]) : null;
}

function https(link: string): string {
  if (link.startsWith("//")) return `https:${link}`;
  if (link.startsWith("http://")) return `https://${link.slice(7)}`;
  return link;
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const SERIAL_TYPES = new Set(["serial", "docuserial", "tvshow", "anime"]);
/** Сериал ли: TMDb-тип точнее нашего (аниме бывает и фильмом). */
const isSerialTarget = (t: OnlineTarget) => (t.tmdbType ? t.tmdbType === "tv" : SERIAL_TYPES.has(t.type));

interface KodikResult {
  link?: string;
  type?: string;
  year?: number;
  quality?: string;
  title?: string;
  title_orig?: string;
  translation?: { id?: number; title?: string };
  last_season?: number;
  last_episode?: number;
  imdb_id?: string;
  kinopoisk_id?: string;
}

/** Kodik: один результат на озвучку; ссылка вида //kodik.info/serial/…  */
export function parseKodik(data: unknown, target: OnlineTarget, byTitle: boolean): OnlineSource[] {
  const results = (data as { results?: KodikResult[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  const serial = isSerialTarget(target);
  const seen = new Set<string>();
  const out: OnlineSource[] = [];
  for (const r of results) {
    if (!r.link || typeof r.link !== "string") continue;
    const rSerial = typeof r.type === "string" && r.type.includes("serial");
    if (rSerial !== serial) continue;
    if (byTitle) {
      // По названию без года не матчим: ремейков и тёзок слишком много.
      if (!target.year || !r.year || Math.abs(r.year - target.year) > 1) continue;
    }
    const label = r.translation?.title?.trim() || "Kodik";
    const key = `${r.translation?.id ?? label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      provider: "kodik",
      label,
      url: https(r.link),
      quality: r.quality ?? null,
      lastSeason: typeof r.last_season === "number" ? r.last_season : null,
      lastEpisode: typeof r.last_episode === "number" ? r.last_episode : null,
    });
  }
  return out;
}

async function kodik(
  token: string,
  target: OnlineTarget,
  fetchImpl: FetchLike,
  apiUrl = "https://kodik-api.com",
): Promise<OnlineSource[]> {
  const base = `${apiUrl.replace(/\/+$/, "")}/search`;
  const q = (params: Record<string, string>) =>
    `${base}?${new URLSearchParams({ token, limit: "100", ...params }).toString()}`;
  if (target.imdbId) {
    const hit = parseKodik(await getJson(fetchImpl, q({ imdb_id: imdbTag(target.imdbId) })), target, false);
    if (hit.length) return hit;
  }
  if (target.kinopoiskId) {
    const hit = parseKodik(await getJson(fetchImpl, q({ kinopoisk_id: String(target.kinopoiskId) })), target, false);
    if (hit.length) return hit;
  }
  const title = target.originalTitle || target.title;
  if (!title || !target.year) return [];
  return parseKodik(
    await getJson(fetchImpl, q({ title_orig: title, strict: "true", year: String(target.year) })),
    target,
    true,
  );
}

/** Alloha: один iframe на тайтл, озвучки переключаются внутри плеера. */
export function parseAlloha(data: unknown): OnlineSource[] {
  const d = data as { status?: string; data?: Record<string, unknown> } | null;
  if (d?.status !== "success" || !d.data) return [];
  const iframe = d.data.iframe;
  if (typeof iframe !== "string" || !iframe) return [];
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
  return [
    {
      provider: "alloha",
      label: "Alloha",
      url: https(iframe),
      quality: typeof d.data.quality === "string" ? d.data.quality : null,
      lastSeason: num(d.data.last_season),
      lastEpisode: num(d.data.last_episode),
    },
  ];
}

async function alloha(token: string, target: OnlineTarget, fetchImpl: FetchLike): Promise<OnlineSource[]> {
  const q = (params: Record<string, string>) =>
    `https://api.alloha.tv/?${new URLSearchParams({ token, ...params }).toString()}`;
  if (target.kinopoiskId) {
    const hit = parseAlloha(await getJson(fetchImpl, q({ kp: String(target.kinopoiskId) })));
    if (hit.length) return hit;
  }
  if (target.imdbId) {
    const hit = parseAlloha(await getJson(fetchImpl, q({ imdb: imdbTag(target.imdbId) })));
    if (hit.length) return hit;
  }
  if (target.tmdbId) return parseAlloha(await getJson(fetchImpl, q({ tmdb: String(target.tmdbId) })));
  return [];
}

export function balancersEnabled(cfg: BalancerConfig): boolean {
  return Boolean(cfg.kodikToken || cfg.allohaToken);
}

/** Все настроенные балансеры параллельно; падение одного не мешает другим. */
export async function findOnlineSources(
  cfg: BalancerConfig,
  target: OnlineTarget,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<OnlineSource[]> {
  const jobs: Array<Promise<OnlineSource[]>> = [];
  if (cfg.kodikToken) jobs.push(kodik(cfg.kodikToken, target, fetchImpl, cfg.kodikApiUrl));
  if (cfg.allohaToken) jobs.push(alloha(cfg.allohaToken, target, fetchImpl));
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
}
