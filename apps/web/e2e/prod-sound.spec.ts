import { expect, test } from "@playwright/test";

/**
 * Проверка звука на проде: gst-HLS транскодит AC3 в AAC, WebAudio-анализатор
 * должен видеть реальные частоты дорожки дубляжа.
 */
const SITE = "http://94.103.1.126";

test("прод: AC3-фильм играет со звуком в Chrome", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${SITE}/login`);
  await page.getByTestId("email-input").fill("owner@zal.local");
  await page.getByTestId("password-input").fill("change-me-owner");
  await page.getByTestId("auth-submit").click();
  await page.waitForSelector('[data-testid="header-user"]', { timeout: 30_000 });

  await page.goto(`${SITE}/watch/84/84`);
  // Источники ищутся под спиннером — ждём плеер.
  await page.waitForSelector('[data-testid="player-video"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => (document.querySelector("video")?.readyState ?? 0) >= 1,
    undefined,
    { timeout: 60_000 },
  );

  // Анализатор на реальный аудиовыход.
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
    (window as unknown as { __audio: unknown }).__audio = { analyser };
  });

  await page.getByTestId("play-toggle").first().click();
  await page.waitForFunction(
    () => (document.querySelector("video")?.currentTime ?? 0) > 1,
    undefined,
    { timeout: 60_000 },
  );

  const power = (): Promise<number> =>
    page.evaluate(() => {
      const w = window as unknown as { __audio?: { analyser: AnalyserNode } };
      const a = w.__audio?.analyser;
      if (!a) return -999;
      const buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return 10 * Math.log10(Math.sqrt(sum / buf.length) + 1e-12);
    });

  // Звук есть ⇔ RMS ощутимо выше шума (-100дБ ≈ тишина).
  await expect
    .poll(power, { timeout: 30_000, intervals: [500], message: "звук не пошёл" })
    .toBeGreaterThan(-70);
});
