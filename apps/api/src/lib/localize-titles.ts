/**
 * Тайтлы с названием только на иероглифах/деванагари/хангыле («フラクタル»,
 * «一路向西») — TMDb отдал оригинал, т. к. ru-перевода в основном ответе нет.
 * Берём /translations: русское название, иначе английское. Раз в час пачкой.
 */
import type { Db } from "@zal/db";
import { sql } from "drizzle-orm";
import type { Config } from "../config";
import { tmdbGet } from "./tmdb";

/** Есть ли в названии кириллица/латиница (читаемо для русского зрителя). */
export function isReadableTitle(title: string): boolean {
  return /[А-Яа-яЁёA-Za-z]/.test(title) || /^[\d\s\p{P}\p{S}]+$/u.test(title);
}

interface Translation {
  iso_639_1: string;
  iso_3166_1: string;
  data: { title?: string; name?: string };
}

/** Лучшее читаемое название из переводов TMDb: ru → en (US первым) → любое латиницей. */
export function pickLocalizedTitle(translations: Translation[]): string | null {
  const title = (t: Translation) => (t.data.title ?? t.data.name ?? "").trim();
  const ok = (t: Translation) => title(t) !== "" && /[А-Яа-яЁёA-Za-z]/.test(title(t));
  const ru = translations.find((t) => t.iso_639_1 === "ru" && ok(t));
  if (ru) return title(ru);
  const en = [...translations]
    .filter((t) => t.iso_639_1 === "en" && ok(t))
    .sort((a, b) => Number(b.iso_3166_1 === "US") - Number(a.iso_3166_1 === "US"))[0];
  if (en) return title(en);
  const any = translations.find(ok);
  return any ? title(any) : null;
}

export async function localizeForeignTitles(
  db: Db,
  config: Config,
  opts: { limit?: number; dryRun?: boolean; log?: (s: string) => void } = {},
): Promise<number> {
  const res = await db.execute<{ id: number; title: string; type: string; tmdb_id: number }>(sql`
    select id, title, type, tmdb_id from items
    where tmdb_id is not null and title !~ '[А-Яа-яЁёA-Za-z]' and title !~ '^[0-9[:space:][:punct:]]+$'
      and (title_localized_at is null or title_localized_at < now() - interval '30 days')
    order by views desc nulls last, id
    limit ${opts.limit ?? 50}
  `);
  let fixed = 0;
  for (const r of res.rows as Array<{ id: number; title: string; type: string; tmdb_id: number }>) {
    const kind = r.type === "movie" ? "movie" : "tv";
    const tr = await tmdbGet<{ translations: Translation[] }>(config, `/${kind}/${r.tmdb_id}/translations`);
    if (!tr) continue;
    const next = pickLocalizedTitle(tr.translations ?? []);
    opts.log?.(`  #${r.id} «${r.title}» → ${next ? `«${next}»` : "—"}`);
    if (opts.dryRun) continue;
    if (next) {
      await db.execute(sql`
        update items set
          original_title = coalesce(original_title, title),
          title = ${next},
          title_localized_at = now(),
          updated_at = now()
        where id = ${r.id}`);
      fixed++;
    } else {
      // Переводов нет — не долбим TMDb каждый час, повтор через 30 дней.
      await db.execute(sql`update items set title_localized_at = now() where id = ${r.id}`);
    }
  }
  return fixed;
}
