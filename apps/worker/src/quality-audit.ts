/**
 * Ночной quality-audit каталога → таблица quality_anomalies.
 *
 * Виды: long_season (сезон > 60 серий), numbering_gap (дыры в нумерации),
 * duplicate_episode (одна серия источника дважды), duplicate_item (одно
 * название + год + тип), no_source (резолв дважды подряд не нашёл раздачу),
 * no_episodes (сериал без серий и без tmdb_id — гидрация не спасёт).
 *
 * Автофиксы — только безопасные: удалить пустые сезоны; применить ручные
 * раскладки season_overrides (новые и изменённые). Исчезнувшие аномалии
 * закрываются (resolved), помеченные человеком ignored — не переоткрываются.
 *
 *   pnpm --filter @zal/worker exec tsx src/quality-audit.ts [--dry]
 */
import {
  type AnomalyInput,
  applySeasonOverride,
  createDb,
  createPool,
  deleteEmptySeasons,
  findDuplicateEpisodes,
  findDuplicateItems,
  findLongSeasons,
  findNoSourceItems,
  findSeasonNumberings,
  findSerialsWithoutEpisodes,
  listPendingSeasonOverrides,
  syncAnomalies,
} from "@zal/db";
import { groupBy, LONG_SEASON_AUDIT, summarizeGaps } from "./lib/audit-rules";
import { parseArgs } from "./lib/script";

const { flag } = parseArgs();
const dryRun = flag("dry");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const db = createDb(createPool(databaseUrl));
const started = Date.now();

// 1) Автофиксы — до поиска, чтобы отчёт видел уже исправленное.
let overrides = 0;
if (!dryRun) {
  for (const o of await listPendingSeasonOverrides(db)) {
    try {
      const res = await applySeasonOverride(db, o.itemId, o.layout);
      overrides++;
      console.log(`quality-audit: override #${o.itemId} → ${res.seasons} сезонов, ${res.episodes} серий, не найдено ${res.unmatched}`);
    } catch (err) {
      console.warn(`quality-audit: override #${o.itemId} failed: ${String(err).slice(0, 200)}`);
    }
  }
}
const emptyRemoved = dryRun ? 0 : await deleteEmptySeasons(db);

// 2) Поиск аномалий.
const long = await findLongSeasons(db, LONG_SEASON_AUDIT);
const longFound: AnomalyInput[] = [...groupBy(long, (r) => Number(r.item_id))].map(([itemId, rows]) => ({
  itemId,
  kind: "long_season",
  details: { layout: rows[0]?.layout ?? null, seasons: rows.map((r) => ({ season: Number(r.season), episodes: Number(r.episodes) })) },
}));

const numbering = await findSeasonNumberings(db);
const gapFound: AnomalyInput[] = [];
for (const [itemId, rows] of groupBy(numbering, (r) => Number(r.item_id))) {
  const seasons = summarizeGaps(rows);
  if (seasons.some((s) => s.missing.length > 0)) gapFound.push({ itemId, kind: "numbering_gap", details: { seasons } });
}

const dupEps = await findDuplicateEpisodes(db);
const dupEpFound: AnomalyInput[] = [...groupBy(dupEps, (r) => Number(r.item_id))].map(([itemId, rows]) => ({
  itemId,
  kind: "duplicate_episode",
  details: { episodes: rows.slice(0, 50).map((r) => [Number(r.orig_season), Number(r.orig_number), Number(r.n)]) },
}));

const dupItems = await findDuplicateItems(db);
const dupItemFound: AnomalyInput[] = dupItems.map((d) => ({
  // Аномалия — на выжившем кандидате (самом популярном), остальные — в деталях.
  itemId: Number(d.ids[0]),
  kind: "duplicate_item",
  details: { title: d.title, year: d.year, type: d.type, ids: d.ids.map(Number) },
}));

const noSource: AnomalyInput[] = (await findNoSourceItems(db)).map((r) => ({
  itemId: Number(r.id),
  kind: "no_source",
  details: { fails: Number(r.fails), at: r.at },
}));

const noEpisodes: AnomalyInput[] = (await findSerialsWithoutEpisodes(db)).map((r) => ({
  itemId: Number(r.id),
  kind: "no_episodes",
  details: { tmdbId: r.tmdb_id == null ? null : Number(r.tmdb_id) },
}));

const report: Array<[string, AnomalyInput[]]> = [
  ["long_season", longFound],
  ["numbering_gap", gapFound],
  ["duplicate_episode", dupEpFound],
  ["duplicate_item", dupItemFound],
  ["no_source", noSource],
  ["no_episodes", noEpisodes],
];

for (const [kind, found] of report) {
  if (dryRun) {
    console.log(`quality-audit: ${kind}: ${found.length}${found.length ? ` (например #${found.slice(0, 5).map((f) => f.itemId).join(", #")})` : ""}`);
    continue;
  }
  const res = await syncAnomalies(db, kind as AnomalyInput["kind"], found);
  console.log(`quality-audit: ${kind}: открыто ${res.opened}, закрыто ${res.resolved}`);
}

console.log(
  `quality-audit: готово за ${((Date.now() - started) / 1000).toFixed(1)}с; автофиксы: ` +
    `пустых сезонов удалено ${emptyRemoved}, ручных раскладок применено ${overrides}`,
);
process.exit(0);
