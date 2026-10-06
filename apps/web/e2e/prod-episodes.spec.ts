import { expect, test } from "@playwright/test";

/**
 * Прод: выбор серии прямо в плеере.
 *
 * Раньше из плеера можно было только «следующая серия»: чтобы попасть в S3E7,
 * приходилось возвращаться на карточку тайтла. Теперь в панели есть меню серий,
 * сгруппированное по сезонам.
 *
 * Проверяем то, чего не видит юнит-тест: список строится на сервере из
 * настоящего ответа API, а меню открывается на том сезоне, который играет.
 *
 * Фикстур выбран по двум признакам, и оба обязательны. «Гранд тур» — сериал с
 * шестью сезонами и 47 сериями (иначе группировку не на чем проверять), и его
 * верхняя раздача транскодируется: в мастере `avc1.640028,mp4a.40.2`, то есть
 * H.264 + AAC, которые Chrome берёт. Это важно не для красоты: когда все
 * раздачи мертвы, плеер показывает панель ошибки поверх панели управления, и
 * меню становится недоступно — на 21111 (GOING SEVENTEEN) тест именно так и
 * упёрся. Заодно это отдельная находка: при отказе раздачи меню серий, то есть
 * единственный способ уйти на другую серию, закрыто панелью ошибки.
 *
 * Запуск (в обычный прогон не входит, testIgnore):
 *   cd apps/web && npx playwright test --config=playwright.prod.config.ts -g серии
 */
const SITE = "https://kino.leonidku.ru";
const ITEM = 20961;
const S3E1 = 40501; // Сезон 3, серия 1 — с неё начинаем
const S3E2 = 40502; // Сезон 3, серия 2 — на неё переключаемся
const S1E1 = 40477; // Сезон 1, серия 1 — в открытом меню её быть не должно

test("прод: меню серий открывается на текущем сезоне и переключает серию", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await page.goto(`${SITE}/watch/${ITEM}/${S3E1}`, { waitUntil: "domcontentloaded" });

  // Панель управления живёт внутри плеера, а плеер появляется, когда API отдал
  // ссылки — резолв раздачи занимает секунды.
  await page.waitForSelector('[data-testid="menu-серии"]', { timeout: 120_000 });

  // Панель прячется через 3 с после старта воспроизведения.
  const openMenu = async () => {
    await page.mouse.move(400, 300);
    await page.waitForTimeout(300);
    await page.getByTestId("menu-серии").click();
  };

  await openMenu();

  const tabs = await page.locator('[data-testid="player-season-tab"]').allInnerTexts();
  const activeTab = await page
    .locator('[data-testid="player-season-tab"][data-active="true"]')
    .innerText();
  const episodes = await page.locator('[data-testid^="player-episode-"]').count();
  const activeEpisode = await page
    .locator('[data-testid^="player-episode-"][data-active="true"]')
    .first()
    .getAttribute("data-testid");

  console.log(`  сезонов в меню : ${tabs.length} — ${tabs.map((t) => t.trim()).join(", ")}`);
  console.log(`  открыт на      : ${activeTab.trim()}`);
  console.log(`  серий в сезоне : ${episodes}`);
  console.log(`  подсвечена     : ${activeEpisode}`);

  // Все шесть сезонов на месте: список пришёл из ответа API целиком.
  expect(tabs.length).toBe(6);
  // Меню открылось на третьем сезоне, а не на первом.
  expect(activeTab.trim()).toBe("Сезон 3");
  // В третьем сезоне 14 серий; меньше — список обрезан.
  expect(episodes).toBe(14);
  // Подсвечена именно играющая серия.
  expect(activeEpisode).toBe(`player-episode-${S3E1}`);
  // Первой серии первого сезона в открытом сезоне нет — иначе в списке лежат
  // mediaId всех сезонов сразу, а группировка декоративная.
  expect(await page.getByTestId(`player-episode-${S1E1}`).count()).toBe(0);

  // Переключение: клик по соседней серии меняет маршрут на её mediaId.
  await page.getByTestId(`player-episode-${S3E2}`).click();
  await page.waitForURL(new RegExp(`/watch/${ITEM}/${S3E2}$`), { timeout: 30_000 });

  await page.waitForSelector('[data-testid="menu-серии"]', { timeout: 120_000 });
  await openMenu();

  const afterTab = await page
    .locator('[data-testid="player-season-tab"][data-active="true"]')
    .innerText();
  const afterEpisode = await page
    .locator('[data-testid^="player-episode-"][data-active="true"]')
    .first()
    .getAttribute("data-testid");

  console.log(`  после перехода : ${afterTab.trim()} / ${afterEpisode}`);

  // Плеер пересоздан на новую серию, и меню снова открылось на ней же.
  expect(afterTab.trim()).toBe("Сезон 3");
  expect(afterEpisode).toBe(`player-episode-${S3E2}`);
});
