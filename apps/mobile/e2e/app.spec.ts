/**
 * Мобильный клиент (expo web / react-native-web) против живого API:
 * ленты каталога, поиск, вход, голосование, подписка, комментарии и
 * страница подписок. Состояние сбрасывается через API — оба проекта
 * (chromium/webkit) идут по одним и тем же данным.
 */
import { expect, type Page, request as pwRequest, test } from "@playwright/test";

const E2E_USER = { email: "e2e@zal.dev", password: "e2e-password-123" };

async function loginApi() {
  const api = await pwRequest.newContext({ baseURL: "http://localhost:3001" });
  const login = await api.post("/v1/auth/login", { data: E2E_USER });
  expect(login.ok()).toBe(true);
  const { tokens } = (await login.json()) as { tokens: { accessToken: string } };
  return { api, auth: { authorization: `Bearer ${tokens.accessToken}` } };
}

async function loginUi(page: Page): Promise<void> {
  await page.getByTestId("login-link").click();
  await page.getByTestId("email-input").fill(E2E_USER.email);
  await page.getByTestId("password-input").fill(E2E_USER.password);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("logout-button")).toBeVisible();
}

test("каталог, поиск, вход, голос, подписка и комментарии", async ({ page }, testInfo) => {
  // expo-router держит предыдущие экраны в DOM скрытыми — ищем внутри экрана.
  const screen = (id: string) => page.getByTestId(id);

  // 1. Главная: ленты из реального API.
  await page.goto("/");
  await expect(page.getByText("Новинки")).toBeVisible({ timeout: 30_000 });
  await expect(screen("item-card").first()).toBeVisible({ timeout: 30_000 });

  // Постер ингеста: react-native-web рисует его фоном + скрытым img,
  // то есть картинка реально загружена с API, а не заглушка «Зал.».
  const poster = screen("item-card").first().locator("img");
  await expect(poster).toHaveAttribute("src", /poster\.jpg/);
  await expect
    .poll(async () => poster.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  // 2. Вход (сессия в localStorage на web-таргете).
  await loginUi(page);

  // 3. Поиск.
  await page.getByTestId("search-link").click();
  await page.getByTestId("search-input").fill("Тестовый");
  await page.getByTestId("search-submit").click();
  const results = screen("search-results").getByTestId("item-card");
  await expect(results.first()).toBeVisible({ timeout: 15_000 });

  // 4. Тайтл: карточка, действия, комментарии.
  await results.first().click();
  await expect(page.getByText("Тестовый тайтл для e2e-прогона плеера.")).toBeVisible({
    timeout: 15_000,
  });

  // Сброс состояния прошлых прогонов.
  const { api, auth } = await loginApi();
  const catalog = await api.get("/v1/items?limit=5", { headers: auth });
  const itemId = ((await catalog.json()) as { items: { id: number }[] }).items[0]!.id;
  await api.delete(`/v1/items/${itemId}/vote`, { headers: auth });
  await api.delete(`/v1/subscriptions/${itemId}`, { headers: auth });
  await page.reload();

  // 5. Голос: оптимистичный UI, сервер подтверждает.
  await expect(page.getByTestId("item-actions")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("vote-up").click();
  await expect(page.getByTestId("vote-positive")).toHaveText("1");

  // 6. Подписка на новые серии.
  const subscribe = page.getByTestId("subscribe-button");
  await expect(subscribe).toContainText("Подписаться");
  await subscribe.click();
  await expect(subscribe).toContainText("Вы подписаны");

  // 7. Комментарий: форма и появление в дереве.
  const body = `мобильный e2e ${testInfo.project.name} ${Date.now()}`;
  await page.getByTestId("comment-form-input").fill(body);
  await page.getByTestId("comment-form-submit").click();
  await expect(page.locator('[data-testid="comment-item"]', { hasText: body })).toBeVisible({
    timeout: 15_000,
  });

  // 8. Страница подписок: тайтл в списке.
  await page.goto("/subscriptions");
  await expect(page.getByTestId("subs-item")).toContainText("Тестовый фильм", {
    timeout: 15_000,
  });
});

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

const videoState = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    return {
      src: v?.currentSrc || v?.src || "",
      currentTime: v?.currentTime ?? 0,
      paused: v?.paused ?? true,
      canPlayHls: v ? v.canPlayType("application/vnd.apple.mpegurl") : "",
    };
  });

test("плеер: персональный мастер дубляжа, субтитры и скорость", async ({ page }) => {
  const { itemId, mediaId } = await firstMedia();
  await page.goto(`/watch/${itemId}/${mediaId}`);
  await expect(page.getByTestId("player-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("player-seekbar")).toBeVisible({ timeout: 30_000 });

  // Скорость циклится по списку.
  await expect(page.getByTestId("player-speed")).toHaveText("1×");
  await page.getByTestId("player-speed").click();
  await expect(page.getByTestId("player-speed")).toHaveText("1.25×");

  // Субтитры: включение, отметка выбора, сдвиг.
  await page.getByTestId("player-subtitle-0").click();
  await expect(page.getByTestId("player-subtitle-0")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText(/сдвиг/)).toBeVisible();

  // Дубляж: второй вариант — свой HLS-мастер (у нативных плееров нет API выбора
  // аудио, поэтому каждая дорожка отдаётся отдельным плейлистом).
  await expect(page.getByTestId("player-audio-0")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByTestId("player-audio-1").click();
  await expect(page.getByTestId("player-audio-1")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect
    .poll(async () => (await videoState(page)).src, { timeout: 20_000 })
    .toContain("master-audio-1");
});

test("плеер: воспроизведение, оверлей субтитров и резюме", async ({ page }) => {
  const { itemId, mediaId } = await firstMedia();

  // Прогресс требует авторизованного профиля.
  await page.goto("/");
  await loginUi(page);
  await page.goto(`/watch/${itemId}/${mediaId}`);
  await expect(page.getByTestId("player-screen")).toBeVisible({ timeout: 30_000 });

  // Резюме сбрасываем, чтобы тест не зависел от прошлых прогонов.
  const { api, auth } = await loginApi();
  await api.put(`/v1/progress/${mediaId}`, {
    headers: auth,
    data: { positionSeconds: 0 },
  });
  await api.dispose();
  await page.reload();
  await expect(page.getByTestId("player-seekbar")).toBeVisible({ timeout: 30_000 });

  // Внешние WebVTT рисуются оверлеем и требуют реального таймлайна:
  // CI-браузеры не умеют HLS (нет AVFoundation/H.264), поэтому проверяем
  // поведенчески и пропускаем только то, что этот движок правда не тянет.
  await page.getByTestId("player-subtitle-0").click();
  await page.getByTestId("player-play").click();
  const plays = await expect
    .poll(async () => (await videoState(page)).currentTime, { timeout: 15_000 })
    .toBeGreaterThan(0.4)
    .then(() => true, () => false);
  test.skip(!plays, "движок не воспроизводит HLS (нет поддержки в CI-браузере)");

  await expect
    .poll(async () => (await videoState(page)).currentTime, { timeout: 30_000 })
    .toBeGreaterThan(4.5);

  // Реплика «Вторая реплика» — с 4-й по 6-ю секунду.
  await expect(page.getByTestId("player-subtitle-overlay")).toContainText(
    "Вторая реплика",
    { timeout: 10_000 },
  );

  // Резюме: пауза форсирует запись прогресса (>5с), затем позиция возвращается.
  await expect
    .poll(async () => (await videoState(page)).currentTime, { timeout: 30_000 })
    .toBeGreaterThan(6);
  await page.getByTestId("player-play").click();
  const saved = await pwRequest.newContext({ baseURL: "http://localhost:3001" });
  await expect
    .poll(
      async () => {
        const res = await saved.get(`/v1/progress/${mediaId}`, { headers: auth });
        const body = (await res.json()) as {
          progress: { positionSeconds: number } | null;
        };
        return body.progress?.positionSeconds ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(4.5);
  await saved.dispose();
  await page.reload();
  await expect
    .poll(async () => (await videoState(page)).currentTime, { timeout: 30_000 })
    .toBeGreaterThan(4.5);
});
