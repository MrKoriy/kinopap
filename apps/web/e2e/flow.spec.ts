/**
 * Главный e2e-флоу: вход → каталог → тайтл → плеер → прогресс → резюме.
 * Реальные серверы, реальный ffmpeg-контент, реальное воспроизведение.
 * Прогресс сбрасывается перед плеером — каждый проект обязан пройти
 * через настоящее декодирование, а не через резюме прошлого прогона.
 */
import { expect, test, request as pwRequest } from "@playwright/test";

const E2E_USER = { email: "e2e@zal.dev", password: "e2e-password-123" };

async function loginApi() {
  const api = await pwRequest.newContext({ baseURL: "http://localhost:3001" });
  const login = await api.post("/v1/auth/login", { data: E2E_USER });
  expect(login.ok()).toBe(true);
  const { tokens } = (await login.json()) as { tokens: { accessToken: string } };
  return { api, auth: { authorization: `Bearer ${tokens.accessToken}` } };
}

test("каталог → плеер → прогресс → резюме", async ({ page }) => {
  // 1. Вход через UI.
  await page.goto("/login");
  await page.getByTestId("email-input").fill(E2E_USER.email);
  await page.getByTestId("password-input").fill(E2E_USER.password);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("header-user")).toBeVisible();

  // 2. Каталог: фильтры и карточки из реального API.
  await page.goto("/catalog");
  await expect(page.getByTestId("type-filters")).toBeVisible();
  await expect(page.getByTestId("catalog-grid")).toBeVisible();
  await expect(page.getByTestId("item-card").first()).toBeVisible();

  // 3. Страница тайтла.
  await page.getByTestId("item-card").first().click();
  await expect(page.getByTestId("item-title")).toHaveText("Тестовый фильм");
  await page.getByTestId("watch-button").click();
  await expect(page.getByTestId("player")).toBeVisible();

  // 4. Сброс прогресса и перезагрузка: старт с нуля, без чужого резюме.
  const mediaId = Number(page.url().split("/").pop());
  expect(Number.isInteger(mediaId)).toBe(true);
  const { api, auth } = await loginApi();
  const reset = await api.put(`/v1/progress/${mediaId}`, {
    headers: auth,
    data: { positionSeconds: 0, durationSeconds: 0 },
  });
  expect(reset.ok()).toBe(true);
  await page.reload();

  // 5. Плеер: манифест HLS загрузился, UI на месте.
  await expect(page.getByTestId("seekbar")).toBeVisible();
  await expect(page.getByTestId("menu-аудио")).toBeVisible();
  await expect(page.getByTestId("menu-субтитры")).toBeVisible();
  await page.waitForFunction(
    () => (document.querySelector("video")?.readyState ?? 0) >= 1,
    undefined,
    { timeout: 20_000 },
  );
  expect(
    await page.evaluate(() => document.querySelector("video")?.currentTime ?? -1),
  ).toBeLessThan(1);

  // 6. Реальное воспроизведение: ждём >5.5с, пауза пишет прогресс.
  // В bundled Chromium нет кодека H.264 — декодирование проверяем в webkit.
  const canDecode = await page.evaluate(() => {
    const codec = 'video/mp4; codecs="avc1.42E01E"';
    const native = document.createElement("video").canPlayType(codec);
    const mse =
      typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(codec);
    return Boolean(native || mse);
  });
  test.skip(!canDecode, "браузер без H.264 — воспроизведение покрыто webkit-проектом");

  await page.getByTestId("play-toggle").click();
  await page.waitForFunction(
    () => (document.querySelector("video")?.currentTime ?? 0) > 5.5,
    undefined,
    { timeout: 30_000 },
  );
  await page.getByTestId("play-toggle").click(); // пауза

  // 7. Прогресс виден через API (запись с паузы асинхронная — ждём позицию >5с).
  await expect
    .poll(
      async () => {
        const progRes = await api.get(`/v1/progress/${mediaId}`, { headers: auth });
        expect(progRes.ok()).toBe(true);
        const { progress } = (await progRes.json()) as {
          progress: { positionSeconds: number; status: string } | null;
        };
        return progress?.positionSeconds ?? 0;
      },
      { timeout: 10_000, message: "прогресс с паузы не доехал до API" },
    )
    .toBeGreaterThan(5);

  const finalRes = await api.get(`/v1/progress/${mediaId}`, { headers: auth });
  const { progress } = (await finalRes.json()) as {
    progress: { status: string } | null;
  };
  expect(progress!.status).toBe("in_progress");
  await api.dispose();

  // 8. Резюме: после перезагрузки плеер стартует с сохранённой позиции.
  await page.reload();
  await page.waitForFunction(
    () => (document.querySelector("video")?.readyState ?? 0) >= 1,
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => (document.querySelector("video")?.currentTime ?? 0) > 4,
    undefined,
    { timeout: 15_000 },
  );
});

test("субтитры и сдвиг в плеере", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("email-input").fill(E2E_USER.email);
  await page.getByTestId("password-input").fill(E2E_USER.password);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("header-user")).toBeVisible();

  await page.goto("/catalog");
  await page.getByTestId("item-card").first().click();
  await page.getByTestId("watch-button").click();
  await page.waitForFunction(
    () => (document.querySelector("video")?.readyState ?? 0) >= 1,
    undefined,
    { timeout: 20_000 },
  );

  // Субтитры включаются из media-links (WebVTT с ingest).
  await page.getByTestId("menu-субтитры").click();
  await page.getByText("sample.srt").click();
  await expect(page.getByTestId("shift-value")).toHaveText("0.0s");
  await page.getByTestId("shift-plus").click();
  await expect(page.getByTestId("shift-value")).toHaveText("0.1s");
  await page.getByTestId("shift-minus").click();
  await page.getByTestId("shift-minus").click();
  await expect(page.getByTestId("shift-value")).toHaveText("-0.1s");

  // На 1-3с дорожка активна: после перемотки текст субтитров на экране.
  await page.evaluate(() => {
    const v = document.querySelector("video");
    if (v) v.currentTime = 2;
  });
  await expect(page.getByTestId("subtitle-overlay")).toContainText("Привет");
});
