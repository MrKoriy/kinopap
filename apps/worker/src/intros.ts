/**
 * Детектор заставок (MVP): для сезонов популярных сериалов берём первые
 * 6 минут звука соседних серий через TorrServer и ищем общий отрезок
 * 15–150 с — это заставка. Результат пишется в media.intro_start/end
 * (intro_source='audio'), плеер показывает «Пропустить заставку».
 *
 * Запуск (нужны DATABASE_URL, TorrServer и ffmpeg):
 *   pnpm --filter @zal/worker exec tsx src/intros.ts --limit=40
 *   pnpm --filter @zal/worker exec tsx src/intros.ts --limit=5 --episodes=4 --dry
 *
 * Источник — только уже прогретые резолвом серии (media_sources): воркер
 * не ищет торренты сам. Холодный торрент упирается в таймаут ffmpeg —
 * серия помечается проверенной без интро (сброс intro_checked_at вернёт
 * её в очередь).
 */
import { createDb, createPool, listSeasonIntroEpisodes, listSeasonsForIntroDetect, saveDetectedIntro } from "@zal/db";
import { detectSeasonIntros, extractPcm, type Fingerprint, fingerprint } from "@zal/ingest";
import { parseArgs } from "./lib/script";

const { flag, num } = parseArgs();
const dryRun = flag("dry");
const limit = Math.floor(num("limit", 40));
/** Сколько серий сезона слушать за прогон (дальше — следующей ночью). */
const perSeason = Math.max(2, Math.floor(num("episodes", 4)));
const seconds = Math.floor(num("seconds", 360));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL обязателен");
  process.exit(1);
}
const torrServer = (process.env.TORRSERVER_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");

const db = createDb(createPool(databaseUrl));
const started = Date.now();
let found = 0;
let missed = 0;
let failed = 0;

const seasonsList = await listSeasonsForIntroDetect(db, limit);
console.log(`intros: сезонов в очереди ${seasonsList.length}${dryRun ? " (dry run)" : ""}`);

for (const season of seasonsList) {
  const eps = await listSeasonIntroEpisodes(db, season.seasonId);
  // Окно из perSeason серий подряд, начиная с первой непроверенной: у
  // проверенной соседки звук тоже нужен для сравнения.
  const firstOpen = eps.findIndex((e) => !e.checked);
  if (firstOpen < 0) continue;
  const from = Math.max(0, Math.min(firstOpen - (firstOpen > 0 ? 1 : 0), eps.length - perSeason));
  const window = eps.slice(from, from + perSeason);
  if (window.length < 2) continue;

  const prints: (Fingerprint | null)[] = [];
  for (const ep of window) {
    // Внутренний адрес TorrServer по хешу надёжнее публичной ссылки из кэша.
    const url = ep.warm ? `${torrServer}/stream?link=${ep.warm.hash}&index=${ep.warm.fileIndex}&play` : ep.httpUrl;
    if (!url) {
      prints.push(null);
      continue;
    }
    try {
      prints.push(fingerprint(await extractPcm(url, { seconds })));
    } catch (err) {
      failed += 1;
      prints.push(null);
      // Помечаем проверенной, иначе битая серия популярного сериала вечно
      // держала бы его сезон во главе очереди.
      if (!dryRun && !ep.checked) await saveDetectedIntro(db, ep.mediaId, null);
      console.warn(`intros: ${season.title} S${season.seasonNumber}E${ep.episodeNumber} — ${String(err).slice(0, 200)}`);
    }
  }

  // Сравниваем только подряд идущие серии со звуком.
  const ok = window.map((ep, i) => ({ ep, print: prints[i] })).filter((x): x is { ep: (typeof window)[number]; print: Fingerprint } => x.print != null);
  if (ok.length < 2) continue;
  const intros = detectSeasonIntros(ok.map((x) => x.print));
  for (const [i, { ep }] of ok.entries()) {
    if (ep.checked) continue;
    const intro = intros[i] ?? null;
    if (intro) found += 1;
    else missed += 1;
    console.log(
      `intros: ${season.title} S${season.seasonNumber}E${ep.episodeNumber} → ${intro ? `${intro.start}–${intro.end}с` : "не найдено"}`,
    );
    if (!dryRun) await saveDetectedIntro(db, ep.mediaId, intro);
  }
}

console.log(
  `intros: готово за ${Math.round((Date.now() - started) / 1000)}с — найдено ${found}, без заставки ${missed}, ошибок звука ${failed}`,
);
process.exit(0);
