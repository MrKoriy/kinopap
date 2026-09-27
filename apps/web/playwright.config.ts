import { defineConfig } from "@playwright/test";

/**
 * E2E: web (:3000, production build) + harness (:3001: PGlite, ffmpeg-ingest, API).
 * Браузер выбирается флагом --project (webkit: нативный HLS + H.264).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
  },
  projects: [
    { name: "webkit" },
    { name: "chromium" },
  ],
  webServer: [
    {
      // Сироты от прошлых прогонов держат порты — гасим перед стартом.
      // Лог сервера — в файл: видно 429/ошибки, когда тесты зелёные.
      command:
        "sh -c 'for p in $(lsof -ti tcp:3001); do kill -9 $p 2>/dev/null; done; exec npx tsx e2e/server.ts > /tmp/zal-e2e-server.log 2>&1'",
      url: "http://localhost:3001/healthz",
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // .next/cache несёт fetch/ISR-кэш прошлых прогонов с чужими media-ключами.
      command:
        "sh -c 'for p in $(lsof -ti tcp:3000); do kill -9 $p 2>/dev/null; done; rm -rf .next/cache; exec npx next start -p 3000'",
      url: "http://localhost:3000",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
