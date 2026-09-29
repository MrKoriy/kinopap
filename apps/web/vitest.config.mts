import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
    },
    // @zal/shared/react импортирует react из исходников пакета: без dedupe
    // vite может отрезолвить вторую копию react, и хук увидит чужой dispatcher.
    dedupe: ["react"],
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
