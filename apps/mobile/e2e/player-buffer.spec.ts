/**
 * Полоса буфера в мобильном плеере — живая проверка.
 *
 * Почему отдельная спека и почему с подменой медиа.
 *
 * В CI-браузерах этот плеер не играет: источник — HLS, а ни Chromium, ни
 * webkit из сборки Playwright его не тянут (поэтому тест воспроизведения в
 * app.spec.ts пропускает себя сам). Без воспроизведения нет ни `buffered`, ни
 * `bufferedPosition`, то есть проверить полосу нечем — она бы просто не
 * появилась, и «зелёный» прогон не доказывал бы ничего.
 *
 * Поэтому поток подменяется обычным MP4. Подменять приходится ДВА места, и оба
 * неочевидны.
 *
 * 1. Адрес в ответе `/media-links`. Мало подсунуть MP4 вместо плейлиста:
 *    десктопный Chromium выбирает демультиплексор по расширению в адресе, а не
 *    по `content-type`. Замерено матрицей 2×2 (те же байты, тот же
 *    `content-type: video/mp4`):
 *
 *      свой origin, .mp4   → играет, duration 30
 *      свой origin, .m3u8  → error 4 (SRC_NOT_SUPPORTED), duration null
 *      чужой origin, .mp4  → играет, duration 30
 *      чужой origin, .m3u8 → error 4, duration null
 *
 *    То есть дело в расширении, а не в origin и не в CORS. Ссылка `urls.hls`
 *    переписывается на относительный `/probe.mp4` — и адрес играбельный, и
 *    вопрос кросс-доменности снимается сам.
 *
 * 2. Ответ на запрос медиа должен поддерживать диапазоны. Chromium запрашивает
 *    `Range: bytes=0-`, и если ответить 200 с файлом целиком, поток считается
 *    несикабельным. Замерено на одном и том же коде плеера:
 *
 *      без диапазонов: seekable ["0-0"], Range-запросов 0, currentTime = 12 → 0
 *      с диапазонами:  seekable ["0-30"], Range-запросов 2, currentTime = 12 → 12
 *
 *    Пока этого не было, перемотка молча упиралась в ноль, и проверить полосу
 *    можно было только в нулевой позиции — то есть ровно там, где ошибка в
 *    формуле не видна.
 *
 * Позиция задаётся перемоткой, а не воспроизведением, и это осознанно.
 * Автоплей без жеста пользователя браузер запрещает, а кнопка play тут не
 * спасает: её обработчик — `player.playing ? pause() : play()`, а `player.playing`
 * expo-video выставляет оптимистично, поэтому кнопка пишет «Пауза» и зовёт
 * `pause()` поверх уже отклонённого `play()`. Перемотка же политике автоплея не
 * подчиняется и идёт тем же путём, что и ползунок: `player.currentTime = x`.
 *
 * Из этого же следует, что до первой перемотки полосы на экране нет вовсе:
 * `bufferedPosition` приходит в `timeUpdate`, а у стоящего на паузе видео оно
 * не срабатывает. Поэтому первая перемотка — ещё и «включатель».
 *
 * Проверяется не «элемент существует», а совпадение геометрии с состоянием
 * самого медиаэлемента: доли полосы сверяются с `video.buffered` и
 * `currentTime`. Именно это отличает рабочую полосу от прямоугольника, который
 * нарисован по неверной формуле.
 *
 * Запуск:
 *   cd apps/mobile && NO_PROXY=localhost CODEBUDDY_SAFE_DELETE_ENABLED=0 \
 *     CODEBUDDY_SAFE_DELETE_BULK_GUARD=0 npx playwright test --project=chromium player-buffer
 *
 * Обе переменные окружения обязательны в песочнице:
 *   NO_PROXY — иначе проба готовности webServer уходит в прокси и получает 502
 *     на живом сервере (см. skill sandbox-localhost-http);
 *   CODEBUDDY_SAFE_DELETE_* — иначе `expo export` не может вычистить dist-e2e
 *     (69 файлов, лимит массового удаления), webServer не поднимается, и прогон
 *     падает с «Process from config.webServer was not able to start».
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, request as pwRequest, test } from "@playwright/test";

/** Длительность подменного ролика: полосе нужен запас, чтобы её было видно. */
const SAMPLE_SECONDS = 30;
const SAMPLE_PATH = path.join(tmpdir(), `zal-e2e-${SAMPLE_SECONDS}s.mp4`);
/** Адрес подмены. Относительный — значит тот же origin, что у страницы. */
const SUBSTITUTE_PATH = "/probe.mp4";
/** Позиции, в которых сверяется геометрия, в секундах. */
const SEEK_POINTS = [12, 24];

/** id первого тайтла и его медиа — из живого API. */
async function firstMedia() {
  const api = await pwRequest.newContext({ baseURL: "http://localhost:3001" });
  const catalog = await api.get("/v1/items?limit=5");
  const itemId = ((await catalog.json()) as { items: { id: number }[] }).items[0]!.id;
  const detail = await api.get(`/v1/items/${itemId}`);
  const media = ((await detail.json()) as { media: { id: number }[] }).media[0]!.id;
  await api.dispose();
  return { itemId, mediaId: media };
}

/** Состояние медиаэлемента: то, с чем обязана сходиться нарисованная полоса. */
const mediaState = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) return null;
    const ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < v.buffered.length; i += 1) {
      ranges.push({ start: v.buffered.start(i), end: v.buffered.end(i) });
    }
    return {
      currentTime: v.currentTime,
      duration: v.duration,
      seekableCount: v.seekable.length,
      ranges,
    };
  });

/** Доли левого края и ширины из инлайнового стиля элемента, в процентах. */
const renderedBand = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="player-buffered"]');
    if (!el) return null;
    const s = (el as HTMLElement).style;
    return { left: Number.parseFloat(s.left), width: Number.parseFloat(s.width) };
  });

/**
 * Ожидаемая геометрия по состоянию медиаэлемента.
 *
 * Повторяет правило expo-video: буфер — это конец того диапазона, внутри
 * которого стоит текущая позиция. Ровно это же делает `bufferedBand`.
 * `null` — позиция вне всех диапазонов, сверять нечего.
 */
function expectedBand(state: {
  currentTime: number;
  duration: number;
  ranges: { start: number; end: number }[];
}): { left: number; width: number } | null {
  const covering = state.ranges.find(
    (r) => r.start <= state.currentTime && r.end >= state.currentTime,
  );
  if (!covering) return null;
  const left = (state.currentTime / state.duration) * 100;
  const width = (Math.min(1, covering.end / state.duration) - state.currentTime / state.duration) * 100;
  return { left, width };
}

/**
 * Дожидается, пока полоса сойдётся с состоянием медиаэлемента.
 *
 * Ждать обязательно: `timeUpdateEventInterval` в expo-video на вебе — это
 * `setInterval` на 250 мс (проверено в VideoPlayer.web.js), то есть после
 * перемотки приложение узнаёт новую позицию с задержкой до четверти секунды.
 * Мгновенное чтение ловит гонку и показывает полосу от предыдущей позиции —
 * именно так проверка и падала: элемент уже на 24 с, а полоса ещё на 40 %.
 *
 * Допуск 2 % — меньше секунды на 30-секундном ролике. Он покрывает разницу
 * между снимком состояния и отрисовкой, но не покрывает ошибку в формуле:
 * неверная формула не сойдётся никогда, и проверка упадёт по таймауту.
 */
async function expectBandMatches(page: Page, where: string) {
  let settled = { band: { left: 0, width: 0 }, want: { left: 0, width: 0 } };
  await expect
    .poll(
      async () => {
        const state = await mediaState(page);
        const band = await renderedBand(page);
        if (!state || !band) return Number.NaN;
        const want = expectedBand(state);
        if (!want) return Number.NaN;
        settled = { band, want };
        return Math.max(Math.abs(band.left - want.left), Math.abs(band.width - want.width));
      },
      { timeout: 20_000, message: `полоса не сошлась с video.buffered (${where})` },
    )
    .toBeLessThan(2);
  return settled;
}

test.beforeAll(() => {
  if (existsSync(SAMPLE_PATH)) return;
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=320x180:r=10:d=${SAMPLE_SECONDS}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "40",
    "-pix_fmt",
    "yuv420p",
    // faststart: moov в начале файла, иначе браузер не начнёт читать, пока не
    // выкачает весь ролик целиком — и буфер наполнялся бы не сразу.
    "-movflags",
    "+faststart",
    SAMPLE_PATH,
  ]);
});

test("полоса буфера: геометрия сходится с video.buffered в двух позициях", async ({ page }) => {
  test.setTimeout(120_000);

  const { itemId, mediaId } = await firstMedia();

  // Подмена первая: адрес потока в ответе API (см. пункт 1 в шапке).
  let rewritten = 0;
  await page.route(
    (url) => url.pathname.endsWith("/media-links"),
    async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { files: { urls: { hls: string | null } }[] };
      for (const file of body.files) {
        if (file.urls.hls) {
          file.urls.hls = SUBSTITUTE_PATH;
          rewritten += 1;
        }
      }
      await route.fulfill({ response: res, json: body });
    },
  );

  // Подмена вторая: сами байты, с поддержкой диапазонов (см. пункт 2 в шапке).
  const mp4 = readFileSync(SAMPLE_PATH);
  let substituted = 0;
  await page.route(
    (url) => url.pathname === SUBSTITUTE_PATH,
    (route) => {
      substituted += 1;
      const range = route.request().headers().range;
      const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
      if (!match) {
        return route.fulfill({
          status: 200,
          contentType: "video/mp4",
          headers: { "accept-ranges": "bytes", "content-length": String(mp4.length) },
          body: mp4,
        });
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : mp4.length - 1;
      const chunk = mp4.subarray(start, end + 1);
      return route.fulfill({
        status: 206,
        contentType: "video/mp4",
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${mp4.length}`,
          "content-length": String(chunk.length),
        },
        body: chunk,
      });
    },
  );

  await page.goto(`/watch/${itemId}/${mediaId}`);
  await expect(page.getByTestId("player-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("player-seekbar")).toBeVisible({ timeout: 30_000 });

  // Ждём метаданные и первый диапазон буфера: проверять полосу до первого
  // `buffered` — значит проверять пустоту.
  await expect
    .poll(async () => {
      const s = await mediaState(page);
      return s ? (s.duration > 0 ? 1 : 0) + (s.ranges.length > 0 ? 1 : 0) : 0;
    }, { timeout: 40_000 })
    .toBe(2);

  // Обе подмены сработали по-настоящему, а не «повезло с таймингом»: пойди
  // плеер на настоящий плейлист, метаданных бы вообще не появилось.
  expect(rewritten, "в ответе API не нашлось ни одной hls-ссылки").toBeGreaterThan(0);
  expect(substituted, "плеер ни разу не запросил подменённый поток").toBeGreaterThan(0);

  // Диапазоны действительно поддерживаются — иначе перемотка ниже уйдёт в
  // никуда, и проверка выродилась бы в «полоса стоит на нуле и это нормально».
  const initial = await mediaState(page);
  expect(initial!.seekableCount, "поток несикабельный — перемотка не сработает").toBeGreaterThan(0);

  // Первая перемотка здесь не только проверка, но и «включатель»: буфер
  // приходит в событии `timeUpdate`, а у стоящего на паузе видео оно не
  // срабатывает — до первой перемотки приложение буфера ещё не знает и полосу
  // не рисует. Проверять её в этот момент нечем.
  const seekTo = async (seconds: number) => {
    await page.evaluate((s) => {
      const v = document.querySelector("video");
      if (v) v.currentTime = s;
    }, seconds);
    await expect
      .poll(async () => Math.abs(((await mediaState(page))?.currentTime ?? 0) - seconds), {
        timeout: 20_000,
      })
      .toBeLessThan(0.5);
  };

  const seen: { at: number; left: number; width: number }[] = [];
  for (const at of SEEK_POINTS) {
    await seekTo(at);
    // Полоса появляется после первого `timeUpdate` — ждём её, а не гадаем.
    await expect
      .poll(async () => (await renderedBand(page)) !== null, {
        timeout: 20_000,
        message: "полоса буфера так и не появилась после перемотки",
      })
      .toBe(true);

    const { band, want } = await expectBandMatches(page, `позиция ${at} с`);
    // Ненулевой левый край — доказательство, что полоса считается от позиции,
    // а не нарисована один раз.
    expect(band.left, `левый край на ${at} с`).toBeGreaterThan(1);
    seen.push({ at, left: band.left, width: band.width });
    console.log(
      `  ${String(at).padStart(2)} с: полоса ${band.left.toFixed(2)}% + ${band.width.toFixed(2)}%` +
        ` (ожидалось ${want.left.toFixed(2)}% + ${want.width.toFixed(2)}%)`,
    );
  }

  // Полоса едет вперёд вместе с позицией, а не стоит на месте.
  expect(seen[1]!.left, "полоса не сдвинулась вслед за второй перемоткой").toBeGreaterThan(
    seen[0]!.left,
  );

  // И возвращается назад, когда позиция уходит в начало: полоса следует за
  // позицией, а не только растёт.
  await seekTo(0);
  const back = await expectBandMatches(page, "возврат в 0");
  expect(back.band.left, "полоса не вернулась к началу").toBeLessThan(2);

  // Полоса идёт ПЕРЕД заливкой проигранного: в react-native-web порядок
  // соседей — это порядок отрисовки, то есть заливка ложится поверх серого.
  const order = await page.evaluate(() => {
    const buffered = document.querySelector('[data-testid="player-buffered"]');
    const fill = document.querySelector('[data-testid="player-seek-fill"]');
    if (!buffered || !fill) return null;
    // 4 — DOCUMENT_POSITION_FOLLOWING: fill идёт после buffered.
    return (buffered.compareDocumentPosition(fill) & 4) !== 0;
  });
  expect(order, "заливка не перекрывает полосу буфера").toBe(true);

  console.log(`  ссылок переписано : ${rewritten}`);
  console.log(`  подмен источника  : ${substituted} запрос(ов)`);
});
