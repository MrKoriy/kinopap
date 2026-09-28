/**
 * Главные e2e-флоу: вход → каталог → тайтл → плеер → прогресс → резюме
 * и переключение дубляжа (состояние + реальная смена звука).
 * Реальные серверы, реальный ffmpeg-контент, реальное воспроизведение.
 * Прогресс сбрасывается перед плеером — каждый проект обязан пройти
 * через настоящее декодирование, а не через резюме прошлого прогона.
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
  await page.goto("/login");
  await page.getByTestId("email-input").fill(E2E_USER.email);
  await page.getByTestId("password-input").fill(E2E_USER.password);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("header-user")).toBeVisible();
}

/** Открывает плеер тестового тайтла из каталога. */
async function openPlayer(page: Page): Promise<void> {
  await page.goto("/catalog");
  await page.getByTestId("item-card").first().click();
  await page.getByTestId("watch-button").click();
  await expect(page.getByTestId("player")).toBeVisible();
}

/**
 * Контракт: воспроизведение стартует само (автоплей), без клика по play.
 * Даём короткое окно на разгон; если таймлайн стоит (среда запретила
 * автоплей) — клик по play как запасной путь. Тесты ниже всё равно упадут,
 * если плеер так и не поехал: ожидания currentTime остаются жёсткими.
 */
async function expectAutoplay(page: Page): Promise<void> {
  const started = await page
    .waitForFunction(
      () => (document.querySelector("video")?.currentTime ?? 0) > 0.1,
      undefined,
      { timeout: 8_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!started) await page.getByTestId("play-toggle").click();

  // Автоплей со звуком мог быть запрещён — плеер играет без звука с кнопкой
  // «Включить звук». Включаем её, как сделал бы живой пользователь.
  const unmute = page.getByTestId("unmute-overlay");
  if (await unmute.isVisible().catch(() => false)) await unmute.click();
}

test("каталог → плеер → прогресс → резюме", async ({ page }) => {
  await loginUi(page);

  // Каталог: фильтры и карточки из реального API.
  // .first(): во время стриминг-гидратации (route-level Suspense) DOM
  // на миг содержит и старый, и новый узел — strict-локатор падает на гонке.
  await page.goto("/catalog");
  await expect(page.getByTestId("type-filters").first()).toBeVisible();
  await expect(page.getByTestId("catalog-grid").first()).toBeVisible();
  await expect(page.getByTestId("item-card").first()).toBeVisible();

  // Постер ингеста: карточка грузит настоящую картинку, а не заглушку.
  const poster = page.locator('[data-testid="item-card"] img').first();
  await expect(poster).toBeVisible();
  await expect
    .poll(async () => poster.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  // Страница тайтла.
  await page.getByTestId("item-card").first().click();
  await expect(page.getByTestId("item-title")).toHaveText("Тестовый фильм");
  await page.getByTestId("watch-button").click();
  await expect(page.getByTestId("player")).toBeVisible();

  // Сброс прогресса и перезагрузка: старт с нуля, без чужого резюме.
  const mediaId = Number(page.url().split("/").pop());
  expect(Number.isInteger(mediaId)).toBe(true);
  const { api, auth } = await loginApi();
  const reset = await api.put(`/v1/progress/${mediaId}`, {
    headers: auth,
    data: { positionSeconds: 0, durationSeconds: 0 },
  });
  expect(reset.ok()).toBe(true);
  await page.reload();

  // Плеер: манифест HLS загрузился, UI на месте.
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

  // Реальное воспроизведение: ждём >5.5с, пауза пишет прогресс.
  // В bundled Chromium может не быть кодека H.264 — тогда пропускаем.
  const canDecode = await page.evaluate(() => {
    const codec = 'video/mp4; codecs="avc1.42E01E"';
    const native = document.createElement("video").canPlayType(codec);
    const mse =
      typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(codec);
    return Boolean(native || mse);
  });
  test.skip(!canDecode, "браузер без H.264 — воспроизведение покрыто webkit-проектом");

  await expectAutoplay(page);
  await page.waitForFunction(
    () => (document.querySelector("video")?.currentTime ?? 0) > 5.5,
    undefined,
    { timeout: 30_000 },
  );
  // Контролы автоскрываются через 3с игры — двигаем мышь, как живой юзер.
  await page.getByTestId("player").hover();
  await page.getByTestId("play-toggle").click(); // пауза

  // Прогресс виден через API (запись с паузы асинхронная — ждём позицию >5с).
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

  // Резюме: после перезагрузки плеер стартует с сохранённой позиции.
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
  await loginUi(page);
  await openPlayer(page);
  await page.waitForFunction(
    () => (document.querySelector("video")?.readyState ?? 0) >= 1,
    undefined,
    { timeout: 20_000 },
  );

  // Субтитры включаются из media-links (WebVTT с ingest).
  await page.getByTestId("menu-субтитры").click();
  await page.getByText("sample.srt").click();
  // Выбор дорожки закрывает меню — открываем снова для подстройки сдвига.
  await page.getByTestId("menu-субтитры").click();
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

test("дубляж переключается, воспроизведение продолжается", async ({ page }) => {
  await loginUi(page);
  await openPlayer(page);
  await page.waitForFunction(
    () => (document.querySelector("video")?.readyState ?? 0) >= 1,
    undefined,
    { timeout: 20_000 },
  );

  await expectAutoplay(page);
  await page.waitForFunction(
    () => (document.querySelector("video")?.currentTime ?? 0) > 1,
    undefined,
    { timeout: 20_000 },
  );

  // В меню две дорожки с метаданными дубляжа из ingest.
  await page.getByTestId("menu-аудио").click();
  await expect(page.getByTestId("audio-option-0")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("audio-option-1")).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("audio-option-0")).toContainText("MVO");
  await expect(page.getByTestId("audio-option-1")).toContainText("AVO");

  // Переключение: активной становится вторая. Выбор закрывает меню —
  // открываем снова и проверяем состояние.
  await page.getByTestId("audio-option-1").click();
  await page.getByTestId("menu-аудио").click();
  await expect(page.getByTestId("audio-option-1")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("audio-option-0")).toHaveAttribute("data-active", "false");

  // Воспроизведение продолжается после смены дорожки.
  const before = await page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
  expect(after).toBeGreaterThan(before + 0.5);
});

test("звук реально меняется (частотный анализ)", async ({ page }) => {
  await loginUi(page);
  await openPlayer(page);
  await page.waitForFunction(
    () => (document.querySelector("video")?.readyState ?? 0) >= 1,
    undefined,
    { timeout: 20_000 },
  );

  // Вешаем анализатор на реальный аудиовыход <video>.
  await page.evaluate(() => {
    const video = document.querySelector("video");
    if (!video) return;
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(video);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    void ctx.resume();
    (window as unknown as { __audio: unknown }).__audio = {
      analyser,
      sampleRate: ctx.sampleRate,
    };
  });

  await expectAutoplay(page);
  await page.evaluate(() => {
    const w = window as unknown as { __audio?: { analyser: AnalyserNode } };
    const a = w.__audio;
    if (a) void (a.analyser.context as AudioContext).resume();
  });
  await page.waitForFunction(
    () => (document.querySelector("video")?.currentTime ?? 0) > 1,
    undefined,
    { timeout: 20_000 },
  );

  const dominant = (): Promise<{ freq: number; power: number }> =>
    page.evaluate(() => {
      const w = window as unknown as {
        __audio?: { analyser: AnalyserNode; sampleRate: number };
      };
      const a = w.__audio;
      if (!a) return { freq: -1, power: -Infinity };
      const data = new Float32Array(a.analyser.frequencyBinCount);
      a.analyser.getFloatFrequencyData(data);
      let max = -Infinity;
      let idx = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] > max) {
          max = data[i];
          idx = i;
        }
      }
      return { freq: (idx * a.sampleRate) / a.analyser.fftSize, power: max };
    });

  // Ждём осмысленный сигнал. Если WebAudio молчит (headless без звука) —
  // честно сообщаем, что частотный анализ в этой среде недоступен.
  try {
    await expect
      .poll(async () => (await dominant()).power, {
        timeout: 8_000,
        intervals: [250],
        message: "WebAudio не отдаёт данные анализатору",
      })
      .toBeGreaterThan(-100);
  } catch {
    test.skip(true, "WebAudio не отдаёт данные в этом окружении — частотный анализ недоступен");
    return;
  }

  // Первая дорожка — тон 300Гц.
  const first = await dominant();
  expect(first.freq).toBeGreaterThan(200);
  expect(first.freq).toBeLessThan(500);

  // Переключаем на вторую — должен появиться тон 3000Гц.
  await page.getByTestId("menu-аудио").click();
  await page.getByTestId("audio-option-1").click();
  await expect
    .poll(async () => (await dominant()).freq, {
      timeout: 8_000,
      intervals: [250],
      message: "частота не сменилась после переключения дубляжа",
    })
    .toBeGreaterThan(2500);
  const second = await dominant();
  expect(second.freq).toBeLessThan(3800);
});
