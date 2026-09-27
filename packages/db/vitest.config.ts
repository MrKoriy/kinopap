import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite под параллельным прогоном turbo уходит за 5с.
    testTimeout: 20_000,
  },
});
