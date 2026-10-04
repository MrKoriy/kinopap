/**
 * Визуальные регрессии @visual: главная, каталог, страница тайтла и модалка
 * трейлера. Отдельный шаг CI (`--grep @visual`), снапшоты лежат рядом
 * в visual.spec.ts-snapshots/ (chromium-linux). Эталоны снимаются на
 * раннере CI: если их нет в репозитории, шаг CI создаёт их
 * (--update-snapshots=missing) и выкладывает артефактом visual-snapshots —
 * его нужно закоммитить, дальше шаг сравнивает строго.
 *
 * Стабилизация: один шрифт на всю страницу (Liberation Sans — пакет
 * fonts-liberation, его ставит `playwright install --with-deps`; системные
 * фолбэки Inter/Arial на машинах различаются), без анимаций и
 * переходов, весь внешний трафик отрезан, картинки/видео/iframe маскируются
 * (кадры ffmpeg и JPEG-кодек зависят от версии ffmpeg).
 *
 * Обновить снапшоты после осознанного изменения вёрстки:
 *   pnpm --filter @zal/web exec playwright test e2e/visual.spec.ts --project=chromium --update-snapshots
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

/** Каталоги Liberation Sans: Debian/Ubuntu и Fedora/Amazon Linux. */
const FONT_DIRS = ["/usr/share/fonts/truetype/liberation", "/usr/share/fonts/liberation-sans", "/usr/share/fonts/liberation"];
const FONTS_DIR = FONT_DIRS.find((d) => existsSync(path.join(d, "LiberationSans-Regular.ttf")));
const FONT_HOST = "http://e2e-fonts.local";

const STABLE_CSS = `
@font-face { font-family: "E2E Sans"; src: url("${FONT_HOST}/LiberationSans-Regular.ttf"); font-weight: 100 500; }
@font-face { font-family: "E2E Sans"; src: url("${FONT_HOST}/LiberationSans-Bold.ttf"); font-weight: 600 900; }
*, *::before, *::after {
  font-family: "E2E Sans", sans-serif !important;
  transition: none !important;
  animation: none !important;
  caret-color: transparent !important;
}
`;

test.use({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", locale: "ru-RU", timezoneId: "Europe/Moscow" });

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "снапшоты сняты только для chromium");
  test.skip(!FONTS_DIR, "нет Liberation Sans (apt install fonts-liberation)");
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === FONT_HOST) {
      return route.fulfill({
        body: readFileSync(path.join(FONTS_DIR!, path.basename(url.pathname))),
        contentType: "font/ttf",
      });
    }
    // Только наш веб и API: YouTube, TMDb-картинки и прочее — мимо.
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.continue();
    return route.fulfill({ status: 204, body: "" });
  });
});

/** Шрифт, без анимаций, сеть утихла, шрифты загружены. */
async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({ content: STABLE_CSS });
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** Медиа — маской: содержимое кадров не предмет снапшота, их место — да. */
const masks = (page: Page) => [page.locator("img"), page.locator("video"), page.locator("iframe"), page.locator("canvas")];

const shot = { animations: "disabled", maxDiffPixelRatio: 0.01 } as const;

test("главная @visual", async ({ page }) => {
  await page.goto("/");
  await stabilize(page);
  await expect(page).toHaveScreenshot("home.png", { ...shot, mask: masks(page) });
});

test("каталог @visual", async ({ page }) => {
  await page.goto("/catalog");
  await expect(page.getByTestId("item-card").first()).toBeVisible();
  await stabilize(page);
  await expect(page).toHaveScreenshot("catalog.png", { ...shot, mask: masks(page) });
});

test("страница тайтла и модалка трейлера @visual", async ({ page }) => {
  await page.goto("/catalog");
  await page.getByTestId("item-card").first().click();
  await expect(page.getByTestId("item-title")).toHaveText("Тестовый фильм");
  await stabilize(page);
  await expect(page).toHaveScreenshot("item.png", { ...shot, fullPage: true, mask: masks(page) });

  await page.getByTestId("trailer-button").click();
  await expect(page.getByTestId("trailer-modal")).toBeVisible();
  // Маска рисуется поверх оверлея — у модалки маскируем только её iframe,
  // а картинки страницы под затемнением просто прячем.
  await expect(page).toHaveScreenshot("trailer-modal.png", {
    ...shot,
    mask: [page.getByTestId("trailer-modal").locator("iframe")],
    stylePath: path.join(__dirname, "visual-hide-media.css"),
  });
});
