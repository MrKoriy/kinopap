import { defineConfig } from "@playwright/test";

/**
 * Прод-проверки (`e2e/prod-*.spec.ts`) бьют по живому серверу и локальных
 * серверов не поднимают. Основной конфиг поднимает webServer (web :3000 +
 * harness :3001) и для этого требует локальной прод-сборки `.next` — на машине,
 * где собирают только на сервере, прод-спеки из-за этого просто не запускаются.
 *
 * Запуск:
 *   cd apps/web && npx playwright test --config=playwright.prod.config.ts
 *   cd apps/web && npx playwright test --config=playwright.prod.config.ts -g mkv
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /prod-.*\.spec\.ts/,
  // Разрешение торрента + перебор раздач + первые сегменты — это минуты.
  timeout: 300_000,
  workers: 1,
  retries: 0,
  projects: [{ name: "chromium" }],
});
