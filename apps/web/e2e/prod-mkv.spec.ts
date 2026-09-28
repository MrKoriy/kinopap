import { expect, test } from "@playwright/test";

/**
 * Прод: MKV/AC3-фильм играет в браузере по HTTPS.
 *
 * Проверяет сразу две вещи, каждая из которых раньше ломала просмотр:
 *
 * 1. HTTPS. Мобильные браузеры идут на HTTPS первыми, а на 443 за голым IP
 *    отвечает чужой сертификат — страница не открывалась вообще. Здесь адрес
 *    именно по имени, и любой запрос на http:// считается провалом (mixed
 *    content браузер блокирует, и каталог с плеером остаются пустыми).
 *
 * 2. Перебор раздач. У 149-го восемь источников, верхний — DVD-remux, который
 *    gst не транскодирует вовсе («unsupported video codec»). Раньше плеер был
 *    заперт на нём и показывал «браузер не поддерживает MKV / AC3». Теперь он
 *    обязан отбросить мёртвую раздачу и заиграть на следующей.
 *
 * Запуск (в обычный прогон не входит, testIgnore):
 *   cd apps/web && npx playwright test e2e/prod-mkv.spec.ts --project=chromium
 */
const SITE = "https://zal.94-103-1-126.sslip.io";
const ITEM = 149;

test("прод: MKV-фильм играет по HTTPS после перебора раздач", async ({ page }) => {
  test.setTimeout(300_000);

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

  // Контролы прячутся через 3 с после старта — двигаем мышь, иначе меню не открыть.
  await page.mouse.move(400, 300);
  await page.waitForTimeout(400);
  await page.getByTestId("menu-качество").click();

  const options = await page.locator('[data-testid^="quality-option-"]').allInnerTexts();
  const active = await page
    .locator('[data-testid^="quality-option-"][data-active="true"]')
    .first()
    .innerText();
  const dead = options.filter((o) => o.includes("не заиграла"));

  const currentTime = await page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
  const errorShown = await page.locator('[data-testid="player-retry"]').count();

  console.log(`  заиграла раздача : ${active.trim()}`);
  console.log(`  отброшено        : ${dead.length} из ${options.length}`);
  for (const d of dead) console.log(`      ${d.trim()}`);
  console.log(`  позиция, с       : ${currentTime.toFixed(1)}`);
  console.log(`  экран ошибки     : ${errorShown > 0 ? "да" : "нет"}`);

  // Ни одного запроса по http:// — иначе на HTTPS-странице всё заблокировано.
  expect(insecure, `запросы по http:// с HTTPS-страницы:\n${insecure.join("\n")}`).toEqual([]);
  // Плеер не должен показывать тупик: перебор обязан был найти живую раздачу.
  expect(errorShown).toBe(0);
  expect(currentTime).toBeGreaterThan(1);
  // Верхняя раздача 149-го — DVD-remux с MPEG-2, gst его не берёт. Если она
  // вдруг заиграла, перебор не проверен: тест перестал быть тестом.
  expect(dead.length, "ни одна раздача не отброшена — перебор не сработал").toBeGreaterThan(0);
});
