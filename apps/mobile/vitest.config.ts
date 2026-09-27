import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Чистая логика без React Native: node-окружение, никаких нативных модулей.
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
