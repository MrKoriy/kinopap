import { expect, test } from "@playwright/test";

/**
 * Прод: серая полоса буфера и перетаскивание ползунка.
 *
 * Юнит-тесты этого не докажут. Во-первых, `video.buffered` в jsdom не
 * существует — там нечего снимать. Во-вторых, перетаскивание держится на
 * `setPointerCapture`, которого в jsdom тоже нет: компонентный тест проходит
 * по ветке «метода нет», а работает ли захват в настоящем браузере, он не
 * проверяет вовсе. Здесь — настоящий Chromium, настоящий HLS и настоящий
 * поток с торрент-раздачи.
 *
 * Фикстур тот же, что у меню серий (20961, S3E1): его верхняя раздача
 * транскодируется в H.264 + AAC, поэтому воспроизведение реально стартует и
 * буфер наполняется. На мёртвой раздаче полосы буфера не будет никогда, и
 * тест упал бы по причине, к буферу отношения не имеющей.
 *
 * Запуск (в обычный прогон не входит, testIgnore):
 *   cd apps/web && npx playwright test --config=playwright.prod.config.ts -g буфер
 */
const SITE = "https://kino.leonidku.ru";
const ITEM = 20961;
const S3E1 = 40501;

/** Доля полосы, куда тянем ползунок. Подальше от начала — там точно есть данные. */
const DRAG_TO = 0.45;
/** Позиция, с которой начинаем жест. */
const DRAG_FROM = 0.15;

test("прод: полоса буфера показывает скачанное, ползунок тянется и мотает", async ({
  page,
}) => {
  test.setTimeout(300_000);

  await page.goto(`${SITE}/watch/${ITEM}/${S3E1}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="player-video"]', { timeout: 120_000 });
  await page.waitForSelector('[data-testid="seekbar"]', { timeout: 120_000 });

  // Панель управления прячется через 3 с после старта игры, а с ней и полоса.
  // Двигаем мышь — она возвращается.
  await page.mouse.move(400, 300);
  await page.waitForTimeout(300);

  const paused = await page.evaluate(
    () => document.querySelector("video")?.paused ?? true,
  );
  if (paused) {
    await page.getByTestId("play-toggle").first().click();
  }

  // Воспроизведение обязано пойти: без него hls.js не отдаст ни одного
  // сегмента в MSE, и `video.buffered` останется пустым.
  await page.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return !!v && v.buffered.length > 0 && v.currentTime > 1;
    },
    undefined,
    { timeout: 180_000 },
  );

  // Полоса буфера появляется только когда снимок непустой. Ждём именно
  // `attached`: панель управления к этому моменту уже спрятана (display:none),
  // и состояние visible не наступит никогда, хотя сегменты в DOM есть и растут.
  await page.waitForSelector('[data-testid="buffer-segment"]', {
    state: "attached",
    timeout: 60_000,
  });

  const state = await page.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) return null;
    return {
      t: v.currentTime,
      d: v.duration,
      ranges: Array.from({ length: v.buffered.length }, (_, i) => [
        v.buffered.start(i),
        v.buffered.end(i),
      ]),
    };
  });
  expect(state).not.toBeNull();
  const { t, d, ranges } = state!;

  const segs = await page
    .locator('[data-testid="buffer-segment"]')
    .evaluateAll((els) =>
      els.map((el) => ({
        start: Number(el.getAttribute("data-start")),
        end: Number(el.getAttribute("data-end")),
        width: (el as HTMLElement).style.width,
      })),
    );

  console.log(`  длительность      : ${d.toFixed(1)} с`);
  console.log(`  позиция           : ${t.toFixed(1)} с`);
  console.log(
    `  диапазоны video   : ${ranges.map(([s, e]) => `${s.toFixed(1)}–${e.toFixed(1)}`).join(", ")}`,
  );
  console.log(
    `  отрезков на полосе: ${segs.length} — ${segs.map((s) => `${(s.start * 100).toFixed(1)}%–${(s.end * 100).toFixed(1)}%`).join(", ")}`,
  );

  // Полоса непустая, каждый отрезок положительной длины, и первый начинается
  // с нуля: поток качается с начала файла, а не с середины.
  expect(segs.length).toBeGreaterThan(0);
  for (const s of segs) {
    expect(s.end).toBeGreaterThan(s.start);
    expect(s.start).toBeGreaterThanOrEqual(0);
    expect(s.end).toBeLessThanOrEqual(1);
  }
  expect(segs[0]!.start).toBe(0);

  // Главный инвариант полосы: место, которое играет прямо сейчас, обязано быть
  // внутри буфера. Если это не так — полоса врёт, и серая заливка бессмысленна.
  const covered = ranges.some(([s, e]) => t >= s && t <= e);
  console.log(`  позиция в буфере  : ${covered ? "да" : "НЕТ"}`);
  expect(covered).toBe(true);

  /* ---------- Перетаскивание ---------- */

  // Мышь уже над плеером, панель на месте — берём координаты полосы.
  await page.mouse.move(400, 300);
  await page.waitForTimeout(300);
  const bar = await page.getByTestId("seekbar").boundingBox();
  expect(bar).not.toBeNull();
  const y = bar!.y + bar!.height / 2;
  const fromX = bar!.x + bar!.width * DRAG_FROM;
  const toX = bar!.x + bar!.width * DRAG_TO;

  const beforeSeek = await page.evaluate(
    () => document.querySelector("video")?.currentTime ?? -1,
  );

  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move(toX, y, { steps: 12 });

  const during = await page.evaluate(() => ({
    width: (document.querySelector('[data-testid="seek-progress"]') as HTMLElement | null)
      ?.style.width,
    t: document.querySelector("video")?.currentTime ?? -1,
  }));

  console.log(`  полоса при drag   : ${during.width}`);
  console.log(
    `  видео при drag    : ${during.t.toFixed(1)} с (было ${beforeSeek.toFixed(1)} с)`,
  );

  // Полоса идёт за указателем: иначе перетаскивание слепое. Допуск в 2% —
  // на субпиксельную раскладку и округление координат мышью.
  const widthPct = Number.parseFloat(during.width ?? "");
  expect(widthPct).toBeGreaterThan(DRAG_TO * 100 - 2);
  expect(widthPct).toBeLessThan(DRAG_TO * 100 + 2);

  // И при этом видео ещё не тронуто: перемотка на торрент-стриме пересобирает
  // конвейер gst, и делать это на каждом pointermove нельзя.
  expect(Math.abs(during.t - beforeSeek)).toBeLessThan(0.5);

  await page.mouse.up();

  // Отпустили — перемотка поехала. Позицию выставляем сразу, поэтому ждём не
  // «доиграло», а «применилось».
  const target = d * DRAG_TO;
  await page.waitForFunction(
    (tt) => Math.abs((document.querySelector("video")?.currentTime ?? 0) - tt) < 5,
    target,
    { timeout: 60_000 },
  );

  const after = await page.evaluate(
    () => document.querySelector("video")?.currentTime ?? -1,
  );
  console.log(`  после отпускания  : ${after.toFixed(1)} с (цель ${target.toFixed(1)} с)`);

  expect(Math.abs(after - target)).toBeLessThan(5);
});
