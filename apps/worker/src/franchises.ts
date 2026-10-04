/**
 * Франшизы аниме через AniList: для каждого аниме каталога ищем его в
 * AniList, обходим граф связей (PREQUEL/SEQUEL/SIDE_STORY/PARENT) и пишем
 * франшизу — сезоны, фильмы, OVA по порядку выхода, с привязкой к нашим
 * карточкам по названию и году.
 *
 * Бережно к лимиту AniList (90/мин): один общий клиент с темпом 0.8 с на
 * запрос, граф — по запросу на уровень. Тайтлы, попавшие в уже собранную
 * франшизу, повторно не ищутся (anilist_checked_at, повтор через 30 дней).
 *
 *   pnpm --filter @zal/worker exec tsx src/franchises.ts --limit=300 [--dry] [--pace=800]
 */
import {
  countAnimeUnchecked,
  createDb,
  createPool,
  listAnimeForFranchise,
  loadTitleIndex,
  markAnilistChecked,
  saveFranchise,
} from "@zal/db";
import { AniListClient, franchiseRootId, orderFranchise, pickSearchHit } from "@zal/ingest";
import { buildEntries, buildTitleIndex, franchiseTitle } from "./lib/franchise-match";
import { parseArgs } from "./lib/script";

const { flag, num } = parseArgs();
const dryRun = flag("dry");
const limit = num("limit", 300);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const db = createDb(createPool(databaseUrl));
const client = new AniListClient({ intervalMs: num("pace", 800) });

const started = Date.now();
const idx = buildTitleIndex(await loadTitleIndex(db));
const candidates = await listAnimeForFranchise(db, limit);
console.log(
  `franchises: ${candidates.length} из ${await countAnimeUnchecked(db)} аниме без франшизы${dryRun ? " (dry run)" : ""}`,
);

const done = new Set<number>();
let saved = 0;
let single = 0;
let missed = 0;

for (const c of candidates) {
  if (done.has(c.id)) continue;
  try {
    let hit = null;
    // Оригинальное название надёжнее: AniList ищет по romaji/english/native.
    for (const q of [c.originalTitle, c.title]) {
      if (!q) continue;
      hit = pickSearchHit(await client.search(q), { titles: [c.title, c.originalTitle], year: c.year });
      if (hit) break;
    }
    if (!hit) {
      missed++;
      if (!dryRun) await markAnilistChecked(db, [c.id]);
      continue;
    }
    const ordered = orderFranchise(await client.franchise(hit));
    if (ordered.length < 2) {
      single++;
      if (!dryRun) await markAnilistChecked(db, [c.id], hit.id);
      continue;
    }
    const entries = buildEntries(ordered, idx, { anilistId: hit.id, itemId: c.id, title: c.title });
    const title = franchiseTitle(entries);
    for (const e of entries) if (e.itemId) done.add(e.itemId);
    if (dryRun) {
      console.log(`  «${title}»: ${entries.map((e) => `${e.format}${e.year ?? ""}${e.itemId ? `→#${e.itemId}` : ""}`).join(", ")}`);
    } else {
      await saveFranchise(db, { rootAnilistId: franchiseRootId(ordered), title, entries });
      await markAnilistChecked(db, [c.id], hit.id);
    }
    saved++;
  } catch (err) {
    console.warn(`franchises: #${c.id} «${c.title}» — ${String(err).slice(0, 200)}`);
  }
}

console.log(
  `franchises: готово. франшиз ${saved}, одиночных ${single}, не найдено ${missed}, ` +
    `запросов AniList ${client.requests}, ${((Date.now() - started) / 1000).toFixed(0)}с`,
);
process.exit(0);
