import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite под параллельным прогоном turbo уходит за 5с; 60с — запас,
    // когда все пакеты тестируются одновременно (см. apps/api/vitest.config.ts).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
