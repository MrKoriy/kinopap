import { expect, test } from "@playwright/test";

/**
 * Прод: MKV/AC3-фильм играет в браузере по HTTPS, а мёртвая раздача
 * отбрасывается перебором.
 *
 * Проверяет сразу две вещи, каждая из которых раньше ломала просмотр:
 *
 * 1. HTTPS. Мобильные браузеры идут на HTTPS первыми, а на 443 за голым IP
 *    отвечает чужой сертификат — страница не открывалась вообще. Здесь адрес
 *    именно по имени, и любой запрос на http:// считается провалом (mixed
 *    content браузер блокирует, и каталог с плеером остаются пустыми).
 *
 * 2. Перебор раздач. Резолвер сортирует раздачи по сидам и размеру и не знает,
 *    транскодируется ли файл: DVD-remux с MPEG-2 gst не берёт вовсе и при этом
 *    стоит первым. Раньше плеер был заперт на такой раздаче и показывал
 *    «браузер не поддерживает MKV / AC3». Теперь он обязан отбросить мёртвую и
 *    заиграть на следующей.
 *
 * Вторая проверка раньше опиралась на то, что верхняя раздача 149-го мёртвая.
 * 29.09.2026 выяснилось, что это перестало быть правдой: проба мастер-плейлиста
 * показала у верхней раздачи `CODECS="avc1.640029,mp4a.40.2"` — H.264 + AAC,
 * то есть Chrome играет её сразу, отбрасывать нечего, и тест падал на своём же
 * стороже. Порядок раздач задаёт внешний каталог, и опираться на него нельзя.
 *
 * Поэтому раздача теперь глушится по хешу: запросы к ней перехватываются и
 * рвутся, и она мертва по построению, независимо от того, что сегодня в
 * каталоге. Заодно проверяется возврат к первой — перебор идёт по возрастанию
 * индекса, потому что список отсортирован по качеству.
 *
 * Запуск (в обычный прогон не входит, testIgnore):
 *   cd apps/web && npx playwright test --config=playwright.prod.config.ts -g MKV
 */
const SITE = "https://kino.leonidku.ru";
const ITEM = 149;
/** Какую раздачу глушим. Не первую: перебор обязан вернуться к первой. */
const DEAD_INDEX = 3;

test("прод: MKV-фильм играет по HTTPS, мёртвая раздача отброшена", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);

  // Ссылки берём у API напрямую: в DOM их нет, а хеш нужен до открытия плеера.
  const res = await request.get(`${SITE}/v1/items/${ITEM}/media-links?mid=${ITEM}`);
  expect(res.ok()).toBe(true);
  const links = (await res.json()) as {
    files: { quality: string; urls: { hls: string | null; http: string | null } }[];
  };
  expect(links.files.length).toBeGreaterThan(DEAD_INDEX);

  const hls = links.files[DEAD_INDEX]!.urls.hls;
  const hash = hls?.split("/")[2] ?? "";
  expect(hash, "в ссылке раздачи нет хеша").not.toBe("");

  // Хеш — идентификатор торрента. Если бы он совпал с хешем первой раздачи, мы
  // глушили бы ту самую, на которой играет плеер, и проверка перебора
  // выродилась бы в проверку «плеер не играет». Условие дешёвое, а молчаливую
  // потерю смысла ловит.
  const firstHash = links.files[0]!.urls.hls?.split("/")[2] ?? "";
  expect(hash).not.toBe(firstHash);

  // Глушим раздачу целиком — и HLS, и прямой стрим. Обе ссылки содержат один и
  // тот же хеш, поэтому предикат по нему закрывает оба пути к торренту.
  //
  // Счётчик нужен как доказательство: без него «отброшено 1 из 8» одинаково
  // выглядит и когда плеер сходил на мёртвую раздачу, и когда он её вообще не
  // тронул (тогда «не заиграла» могло появиться по другой причине).
  let deadHits = 0;
  await page.route(
    (url) => url.href.includes(hash),
    (route) => {
      deadHits += 1;
      return route.abort();
    },
  );

  const insecure: string[] = [];
  page.on("request", (req) => {
    if (req.url().startsWith("http://")) insecure.push(req.url());
  });

  await page.goto(`${SITE}/watch/${ITEM}/${ITEM}`, { waitUntil: "domcontentloaded" });

  // Источники ищутся под спиннером (rutor + TorrServer + TMDb, до ~10 с).
  await page.waitForSelector('[data-testid="player-video"]', { timeout: 90_000 });

  // Ключевая проверка: время идёт. Значит раздача не просто «не упала», а реально
  // играет — транскод, манифест, сегменты.
  await page.waitForFunction(
    () => (document.querySelector("video")?.currentTime ?? 0) > 1,
    undefined,
    { timeout: 150_000 },
  );

  /* ---------- Перебор: выбираем заведомо мёртвую раздачу ---------- */

  // Наблюдатель ставится в страницу ДО клика. Он следит за `currentTime` и ждёт
  // двух событий подряд: провал к нулю (плеер снёс старый поток) и подъём выше
  // двух секунд (новая раздача реально играет). Порознь ни одно ничего не
  // доказывает: время уже больше двух на старой раздаче, а ноль бывает и на
  // паузе. Смотреть больше не на что: меню после клика закрывается, пункт
  // `quality-option-3` уходит из DOM — на нём ожидание висело до таймаута.
  await page.evaluate(() => {
    const w = window as unknown as { __fallback?: { reset: boolean; played: number } };
    const state = { reset: false, played: 0 };
    w.__fallback = state;
    window.setInterval(() => {
      const v = document.querySelector("video");
      if (!v) return;
      if (v.currentTime < 1) state.reset = true;
      if (state.reset && v.currentTime > 2) state.played = v.currentTime;
    }, 100);
  });

  // Контролы прячутся через 3 с после старта — двигаем мышь, иначе меню не
  // открыть. Пункты меню существуют только внутри открытого меню, поэтому и
  // «на чём играет», и выбор мёртвой раздачи делаем отсюда же.
  await page.mouse.move(400, 300);
  await page.waitForTimeout(400);
  await page.getByTestId("menu-качество").click();

  const startedOn = await page
    .locator('[data-testid^="quality-option-"][data-active="true"]')
    .first()
    .innerText();

  await page.getByTestId(`quality-option-${DEAD_INDEX}`).click();

  // Первое доказательство: плеер действительно пошёл на заглушенную раздачу.
  // Без него «отброшено 1 из 8» одинаково выглядит и когда он её пробовал, и
  // когда не трогал вовсе.
  await expect
    .poll(() => deadHits, {
      timeout: 150_000,
      message: "плеер ни разу не запросил заглушенную раздачу — перехват не сработал",
    })
    .toBeGreaterThan(0);

  // Второе: он с неё ушёл и заиграл на другой — время пошло с нуля заново.
  await page.waitForFunction(
    () =>
      ((window as unknown as { __fallback?: { played: number } }).__fallback?.played ?? 0) > 0,
    undefined,
    { timeout: 150_000 },
  );
  const resumedAt = await page.evaluate(
    () => (window as unknown as { __fallback?: { played: number } }).__fallback?.played ?? 0,
  );

  // Меню закрылось кликом по раздаче — открываем заново, чтобы прочитать итог.
  await page.mouse.move(400, 300);
  await page.waitForTimeout(400);
  await page.getByTestId("menu-качество").click();

  const options = await page.locator('[data-testid^="quality-option-"]').allInnerTexts();
  const active = await page
    .locator('[data-testid^="quality-option-"][data-active="true"]')
    .first()
    .innerText();
  const dead = options.filter((o) => o.includes("не заиграла"));
  const currentTime = await page.evaluate(
    () => document.querySelector("video")?.currentTime ?? 0,
  );
  const errorShown = await page.locator('[data-testid="player-retry"]').count();

  console.log(`  старт на раздаче  : ${startedOn.trim()}`);
  console.log(`  заглушена         : [${DEAD_INDEX}] ${links.files[DEAD_INDEX]!.quality}`);
  console.log(`  запросов к мёртвой: ${deadHits}`);
  console.log(`  откат заиграл на  : ${resumedAt.toFixed(1)} с`);
  console.log(`  заиграла раздача  : ${active.trim()}`);
  console.log(`  отброшено         : ${dead.length} из ${options.length}`);
  for (const d of dead) console.log(`      ${d.trim()}`);
  console.log(`  позиция, с        : ${currentTime.toFixed(1)}`);
  console.log(`  экран ошибки      : ${errorShown > 0 ? "да" : "нет"}`);

  // Ни одного запроса по http:// — иначе на HTTPS-странице всё заблокировано.
  expect(insecure, `запросы по http:// с HTTPS-страницы:\n${insecure.join("\n")}`).toEqual([]);
  // Отброшена ровно заглушенная раздача — и никакая другая.
  expect(dead.length).toBe(1);
  expect(dead[0]!.trim()).toContain(links.files[DEAD_INDEX]!.quality);
  // Перебор вернулся к первой: список отсортирован по качеству, и лучшая из
  // живых должна выигрывать, а не «следующая по кругу».
  expect(await page.locator('[data-testid="quality-option-0"][data-active="true"]').count()).toBe(1);
  // Плеер не должен показывать тупик: перебор обязан был найти живую раздачу.
  expect(errorShown).toBe(0);
  expect(currentTime).toBeGreaterThan(1);
});
