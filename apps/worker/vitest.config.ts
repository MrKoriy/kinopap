import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite с миграциями под параллельным прогоном turbo уходит за 10с —
    // тот же запас, что у packages/db и apps/api.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
