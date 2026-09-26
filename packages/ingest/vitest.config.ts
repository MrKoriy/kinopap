import { defineConfig } from "vitest/config";

// Реальный ffmpeg в smoke-тестах — таймауты щедрые.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
