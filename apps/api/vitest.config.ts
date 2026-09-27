import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite + scrypt под параллельным прогоном turbo уходят за 5с.
    testTimeout: 20_000,
  },
});
