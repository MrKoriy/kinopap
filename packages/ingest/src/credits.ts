/**
 * Актёры и команда из TMDb: один запрос деталей с append_to_response —
 * `credits` у фильмов, `aggregate_credits` у сериалов (у обычного /credits
 * сериала только последний сезон). Заодно отдаём backdrop_path: OG-картинка
 * и фон шапки — тем же запросом, а не вторым проходом по каталогу.
 */
import type { PersonRole } from "@zal/api-client";
import type { TmdbClient } from "./tmdb-client";

/** Топ актёров на тайтл: больше в UI не показываем, а хвост раздувает БД. */
export const CAST_LIMIT = 20;
/** Режиссёров/сценаристов/композиторов — по несколько, не весь цех. */
const CREW_LIMIT = 3;

export interface CreditPerson {
  tmdbId: number;
  name: string;
  /** Путь фото TMDb (/abc.jpg) — полный URL собирает потребитель. */
  photoPath: string | null;
  role: PersonRole;
  character: string | null;
  ord: number;
}

export interface TmdbCredits {
  backdropPath: string | null;
  people: CreditPerson[];
}

interface RawCast {
  id?: number;
  name?: string;
  profile_path?: string | null;
  character?: string;
  order?: number;
  /** aggregate_credits: роли по сезонам. */
  roles?: Array<{ character?: string; episode_count?: number }>;
  total_episode_count?: number;
}

interface RawCrew {
  id?: number;
  name?: string;
  profile_path?: string | null;
  job?: string;
  department?: string;
  jobs?: Array<{ job?: string; episode_count?: number }>;
  total_episode_count?: number;
}

interface RawCredits {
  cast?: RawCast[];
  crew?: RawCrew[];
}

export interface RawTmdbDetails {
  backdrop_path?: string | null;
  credits?: RawCredits;
  aggregate_credits?: RawCredits;
  created_by?: Array<{ id?: number; name?: string; profile_path?: string | null }>;
}

const CREW_ROLES: Array<{ role: PersonRole; jobs: RegExp }> = [
  { role: "director", jobs: /^director$/i },
  { role: "writer", jobs: /^(screenplay|writer|novel|story|original story|original concept)$/i },
  { role: "composer", jobs: /^(original music composer|music|composer)$/i },
];

const cleanName = (s: string | undefined) => (s ?? "").trim().slice(0, 255);
const cleanChar = (s: string | undefined) => {
  const t = (s ?? "").replace(/\s*\(voice\)\s*/gi, "").trim();
  return t ? t.slice(0, 255) : null;
};

/** Разбор ответа деталей TMDb в плоский список людей. Чистая функция — под тесты. */
export function parseTmdbCredits(details: RawTmdbDetails): TmdbCredits {
  const raw = details.aggregate_credits ?? details.credits ?? {};
  const out: CreditPerson[] = [];
  const seen = new Set<string>();
  const push = (p: CreditPerson) => {
    const key = `${p.tmdbId}:${p.role}`;
    if (seen.has(key) || !p.name || !(p.tmdbId > 0)) return;
    seen.add(key);
    out.push(p);
  };

  const cast = (raw.cast ?? [])
    .filter((c) => c.id && c.name)
    .slice()
    // aggregate_credits уже отсортирован по сериям, credits — по order.
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, CAST_LIMIT);
  cast.forEach((c, i) => {
    const character = c.character ?? c.roles?.slice().sort((a, b) => (b.episode_count ?? 0) - (a.episode_count ?? 0))[0]?.character;
    push({
      tmdbId: Number(c.id),
      name: cleanName(c.name),
      photoPath: c.profile_path || null,
      role: "actor",
      character: cleanChar(character),
      ord: i,
    });
  });

  for (const { role, jobs } of CREW_ROLES) {
    const crew = (raw.crew ?? [])
      .map((c) => {
        const all = c.jobs ? c.jobs.filter((j) => jobs.test(j.job ?? "")) : jobs.test(c.job ?? "") ? [{ episode_count: 1 }] : [];
        const weight = all.reduce((n, j) => n + (j.episode_count ?? 1), 0);
        return { c, weight };
      })
      .filter((x) => x.weight > 0 && x.c.id && x.c.name)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, CREW_LIMIT);
    for (const [i, { c }] of crew.entries()) {
      push({ tmdbId: Number(c.id), name: cleanName(c.name), photoPath: c.profile_path || null, role, character: null, ord: i });
    }
  }

  // Сериалу «режиссёр» — это создатель шоу: у эпизодов десятки режиссёров.
  if (details.created_by?.length && !out.some((p) => p.role === "director")) {
    for (const [i, c] of details.created_by.slice(0, CREW_LIMIT).entries()) {
      push({
        tmdbId: Number(c.id),
        name: cleanName(c.name),
        photoPath: c.profile_path || null,
        role: "director",
        character: null,
        ord: i,
      });
    }
  }

  return { backdropPath: details.backdrop_path || null, people: out };
}

/**
 * Детали + титры одним запросом. null — TMDb недоступен (ретрай позже),
 * пустой people — титров у тайтла нет (помечаем проверенным).
 */
export async function fetchTmdbCredits(
  client: TmdbClient,
  kind: "movie" | "tv",
  tmdbId: number,
): Promise<TmdbCredits | null> {
  const details = await client.get<RawTmdbDetails>(`/${kind}/${tmdbId}`, {
    params: { append_to_response: kind === "tv" ? "aggregate_credits" : "credits" },
  });
  return details ? parseTmdbCredits(details) : null;
}

const TMDB_IMG = "https://image.tmdb.org/t/p";

/** Строки для replaceItemCredits: пути TMDb → полные URL (фото w185, бэкдроп w1280). */
export function creditsToRows(credits: TmdbCredits): {
  people: Array<Omit<CreditPerson, "photoPath"> & { photoUrl: string | null }>;
  backdropUrl: string | null;
} {
  return {
    people: credits.people.map(({ photoPath, ...p }) => ({
      ...p,
      photoUrl: photoPath ? `${TMDB_IMG}/w185${photoPath}` : null,
    })),
    backdropUrl: credits.backdropPath ? `${TMDB_IMG}/w1280${credits.backdropPath}` : null,
  };
}

/** movie/tv для запроса деталей: tmdb_type точнее типа карточки (аниме бывают и тем, и другим). */
export function tmdbKindOf(row: { type: string; tmdbType?: string | null }): "movie" | "tv" {
  if (row.tmdbType === "tv" || row.tmdbType === "movie") return row.tmdbType;
  return ["serial", "docuserial", "tvshow", "anime"].includes(row.type) ? "tv" : "movie";
}
