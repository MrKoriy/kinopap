/**
 * Страны производства из TMDb. Импорт (catalog-fill / discover) стран не
 * приносит — фильтр «Страна» в каталоге был пустым. Добираем деталями
 * /movie|tv/{id}: production_countries, для сериалов ещё origin_country.
 * Порядок случайный: тайтлы, у которых в TMDb стран нет, не блокируют очередь.
 */
import type { Db } from "@zal/db";
import { sql } from "drizzle-orm";
import type { Config } from "../config";
import { tmdbGet } from "./tmdb";

const OVERRIDES: Record<string, string> = {
  US: "США",
  GB: "Великобритания",
  KR: "Южная Корея",
  KP: "КНДР",
  SU: "СССР",
  HK: "Гонконг",
  CZ: "Чехия",
  AE: "ОАЭ",
};

let names: Intl.DisplayNames | null = null;

/** ISO 3166-1 → короткое русское название; неизвестные коды — null. */
export function countryName(code: string): string | null {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  if (OVERRIDES[c]) return OVERRIDES[c];
  names ??= new Intl.DisplayNames(["ru"], { type: "region" });
  const n = names.of(c);
  if (!n || n === c) return null;
  return n.replace(/\s*\(САР\)$/, "");
}

export function extractCountries(raw: Record<string, unknown>): string[] {
  const codes: string[] = [];
  if (Array.isArray(raw.production_countries)) {
    for (const p of raw.production_countries) {
      const code = (p as { iso_3166_1?: unknown })?.iso_3166_1;
      if (typeof code === "string") codes.push(code);
    }
  }
  if (Array.isArray(raw.origin_country)) {
    for (const code of raw.origin_country) if (typeof code === "string") codes.push(code);
  }
  const out = new Set<string>();
  for (const code of codes) {
    const n = countryName(code);
    if (n) out.add(n);
  }
  return [...out].slice(0, 4);
}

export async function fillCountries(
  db: Db,
  config: Config,
  opts: { limit?: number; concurrency?: number; log?: (line: string) => void } = {},
): Promise<number> {
  if (!config.tmdbApiKey) return 0;
  const rows = (
    await db.execute(sql`
      select i.id, i.tmdb_id, coalesce(i.tmdb_type, case when i.type = 'movie' then 'movie' else 'tv' end) as kind
      from items i
      where i.tmdb_id is not null
        and not exists (select 1 from item_countries ic where ic.item_id = i.id)
      order by random()
      limit ${opts.limit ?? 300}`)
  ).rows as Array<{ id: number; tmdb_id: number; kind: string }>;
  let filled = 0;
  const conc = Math.max(1, opts.concurrency ?? 6);
  for (let i = 0; i < rows.length; i += conc) {
    await Promise.all(
      rows.slice(i, i + conc).map(async (r) => {
        const kind = r.kind === "movie" ? "movie" : "tv";
        const data = await tmdbGet<Record<string, unknown>>(config, `/${kind}/${r.tmdb_id}`);
        if (!data) return;
        const list = extractCountries(data);
        if (list.length === 0) return;
        const ok = await saveCountries(db, r.id, list).then(
          () => true,
          () => false,
        );
        if (!ok) return;
        filled++;
        if (filled % 500 === 0) opts.log?.(`  countries: ${filled}…`);
      }),
    );
  }
  return filled;
}

/** Без applyEnrichment: тот трогает updated_at, а по нему сортируется «Свежее». */
async function saveCountries(db: Db, itemId: number, list: string[]): Promise<void> {
  const titles = sql.join(
    list.map((t) => sql`(${t})`),
    sql`, `,
  );
  const arr = sql.join(
    list.map((t) => sql`${t}`),
    sql`, `,
  );
  await db.execute(sql`insert into countries (title) values ${titles} on conflict (title) do nothing`);
  await db.execute(sql`
    insert into item_countries (item_id, country_id)
    select ${itemId}, id from countries where title in (${arr})
    on conflict do nothing`);
}
