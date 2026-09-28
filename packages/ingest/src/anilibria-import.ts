/**
 * Импорт каталога AniLibria: релиз → item(type=anime) → сезон/эпизоды → media.
 *
 * HLS-ссылки на импорте не сохраняются — у источника они протухают, а резолвер
 * тянет их в момент просмотра (и откатывается на торрент, если AniLibria лежит).
 * Зато сразу появляется вся навигация: серии, интро, постер.
 */

import {
  applyEnrichment,
  type Db,
  listExternalIds,
  publishIngest,
} from "@zal/db";
import { AnilibriaConnector, type AnilibriaRelease } from "./connectors/anilibria";

const EXTERNAL_SOURCE = "anilibria";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AnimeImportOptions {
  db: Db;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Сколько релизов максимум импортировать за прогон. */
  maxReleases?: number;
  /** Пауза между запросами к источнику. */
  requestIntervalMs?: number;
  onProgress?: (p: AnimeImportProgress) => void;
}

export interface AnimeImportProgress {
  /** Релизов осмотрено. */
  listed: number;
  /** Новых тайтлов добавлено. */
  added: number;
  /** Уже были в каталоге (эпизоды обновлены). */
  updated: number;
  /** Сколько эпизодов создано/обновлено. */
  episodes: number;
}

export interface AnimeImportSummary extends AnimeImportProgress {
  durationMs: number;
}

/** Материализация релиза: item + (сезон/эпизоды | одна часть) + media. */
async function materialize(db: Db, release: AnilibriaRelease): Promise<number> {
  const multi = release.episodes.length > 1;
  const item = {
    type: "anime" as const,
    title: release.title,
    originalTitle: release.englishTitle ?? null,
    year: release.year && release.year > 1900 ? release.year : null,
    plot: release.plot ?? null,
    externalSource: EXTERNAL_SOURCE,
    externalId: String(release.id),
    posterSmall: release.posterUrl ?? null,
    posterMedium: release.posterUrl ?? null,
    posterBig: release.posterUrl ?? null,
  };

  let firstItemId: number | null = null;
  let created = 0;
  for (const ep of release.episodes) {
    // Дробные спецвыпуски («Серия 6.5»): episodes.number — integer, а ломать
    // весь импорт из-за одной спец-серии нельзя.
    if (!Number.isInteger(ep.ordinal)) continue;
    const res = await publishIngest(db, {
      item,
      media: {
        episode: multi ? { seasonNumber: 1, episodeNumber: ep.ordinal, title: ep.name } : null,
        title: multi ? ep.name : release.title,
        duration: ep.duration ?? 0,
        sourceKey: `${EXTERNAL_SOURCE}:${release.id}:${ep.ordinal}`,
        introStartSeconds: ep.introStart ?? null,
        introEndSeconds: ep.introStop ?? null,
      },
      files: [],
      audios: [],
      subtitles: [],
    });
    firstItemId ??= res.itemId;
    created += 1;
  }

  if (firstItemId != null) {
    // Жанр «Аниме» — чтобы тайтл находился в жанровых фильтрах.
    await applyEnrichment(db, firstItemId, { genres: ["Аниме"] });
  }

  return created;
}

export async function importAnilibriaCatalog(
  opts: AnimeImportOptions,
): Promise<AnimeImportSummary> {
  const startedAt = Date.now();
  const connector = new AnilibriaConnector(opts.baseUrl, opts.fetch);
  const maxReleases = opts.maxReleases ?? 1000;
  const interval = opts.requestIntervalMs ?? 150;

  const known = await listExternalIds(opts.db, EXTERNAL_SOURCE);
  const out: AnimeImportProgress = { listed: 0, added: 0, updated: 0, episodes: 0 };
  const report = () => opts.onProgress?.({ ...out });

  let page = 1;
  // Infinity — источник не сообщил пагинацию: доходим до первой пустой страницы.
  let totalPages = Number.POSITIVE_INFINITY;
  while (page <= totalPages && out.listed < maxReleases) {
    const { releases, totalPages: reported } = await connector.listReleases(page, 50);
    if (reported > 0) totalPages = reported;
    if (releases.length === 0) break;

    for (const listed of releases) {
      if (out.listed >= maxReleases) break;
      out.listed += 1;

      // Уже в каталоге — не пересобираем эпизоды: повторный fill не должен
      // тратить десятки минут на идемпотентные upsert'ы.
      if (known.has(String(listed.id))) {
        report();
        continue;
      }

      const full = await connector.getRelease(listed.id);
      if (!full || full.episodes.filter((e) => Number.isInteger(e.ordinal)).length === 0) {
        // Без серий играть нечего — осмотрели и пошли дальше.
        report();
        continue;
      }

      let episodes = 0;
      try {
        episodes = await materialize(opts.db, full);
      } catch (err) {
        // Один битой релиз не должен срывать весь импорт (так ловили
        // дробные номера серий — падала вся fill-джоба).
        console.warn(`anilibria: release ${listed.id} failed:`, String(err).slice(0, 200));
        report();
        continue;
      }
      out.added += 1;
      known.add(String(listed.id));
      out.episodes += episodes;
      report();
      await sleep(interval);
    }

    // Источник не сообщил число страниц — доходим до первой пустой.
    if (reported <= 0 && releases.length < 50) break;
    page += 1;
  }

  return { ...out, durationMs: Date.now() - startedAt };
}
