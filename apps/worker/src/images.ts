/**
 * Бэкфилл своих картинок: постеры и бэкдропы → AVIF/WebP по контент-хешу в
 * MEDIA_ROOT/img, blurhash и доминантный цвет — в items. Без файлов веб идёт
 * старым путём через next/image, так что прерывать и запускать можно когда угодно.
 *
 *   pnpm --filter @zal/worker exec tsx src/images.ts [--limit=3000] [--concurrency=3] [--pace=50] [--dry]
 */
import { countItemsMissingImages, createDb, createPool, listItemsMissingImages, setItemImages } from "@zal/db";
import { downloadImage, type ImageKind, processImage, sourceUrl } from "./lib/images";
import { makePacer, parseArgs, runPool } from "./lib/script";

const { flag, num } = parseArgs();
const dryRun = flag("dry");
const limit = num("limit", 3000);
// sharp сам многопоточен (libvips): больше 2–3 параллельных — только память.
const concurrency = Math.floor(num("concurrency", 3));
const pace = makePacer(num("pace", 50));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const mediaRoot = process.env.MEDIA_ROOT ?? "./media";
const db = createDb(createPool(databaseUrl));

const started = Date.now();
const total = await countItemsMissingImages(db);
const rows = await listItemsMissingImages(db, limit);
console.log(`images: ${rows.length} из ${total} тайтлов без своих картинок → ${mediaRoot}/img${dryRun ? " (dry run)" : ""}`);

let done = 0;
let files = 0;
let failed = 0;

async function one(url: string | null, kind: ImageKind) {
  if (!url) return null;
  await pace();
  const buf = await downloadImage(sourceUrl(url, kind));
  if (!buf) return null;
  return processImage(mediaRoot, buf, kind);
}

async function* source() {
  yield* rows;
}

await runPool(source(), concurrency, async (row) => {
  try {
    if (dryRun) return;
    const [poster, backdrop] = [await one(row.poster, "poster"), await one(row.backdrop, "backdrop")];
    files += (poster?.written ?? 0) + (backdrop?.written ?? 0);
    if (!poster && row.poster) failed++;
    await setItemImages(db, row.id, {
      posterHash: poster?.hash ?? null,
      backdropHash: backdrop?.hash ?? null,
      posterBlurhash: poster?.blurhash ?? null,
      dominantColor: poster?.color ?? null,
    });
  } catch (err) {
    failed++;
    console.warn(`images: #${row.id} «${row.title}» — ${String(err).slice(0, 200)}`);
  } finally {
    done++;
    if (done % 200 === 0) console.log(`images: ${done}/${rows.length}, файлов ${files}, ошибок ${failed}`);
  }
});

console.log(`images: готово. ${done} тайтлов, файлов ${files}, ошибок ${failed}, ${((Date.now() - started) / 1000).toFixed(0)}с`);
process.exit(0);
