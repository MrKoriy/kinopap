import { defineConfig } from "@playwright/test";

/**
 * E2E мобильного клиента: expo web-экспорт (react-native-web) на :3002
 * против живого API-харнесса на :3001 (реальный ffmpeg-контент).
 * Плеер проверяется отдельно — нативный HLS в вебе не играет без hls.js.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://localhost:3002",
    // Телефонный вьюпорт: плеер занимает 16:9 от ширины, в десктопном
    // размере контролы уезжают за фолд.
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  },
  projects: [{ name: "chromium" }, { name: "webkit" }],
  webServer: [
    {
      command:
        "sh -c 'for p in $(lsof -ti tcp:3001); do kill -9 $p 2>/dev/null; done; exec npx tsx ../web/e2e/server.ts'",
      url: "http://localhost:3001/healthz",
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command:
        "sh -c 'for p in $(lsof -ti tcp:3002); do kill -9 $p 2>/dev/null; done; EXPO_PUBLIC_API_URL=http://localhost:3001 npx expo export --platform web --output-dir dist-e2e && exec npx tsx e2e/serve.ts'",
      url: "http://localhost:3002",
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
