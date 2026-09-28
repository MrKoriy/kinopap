import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite + scrypt под параллельным прогоном turbo уходят за 5с.
    // 60с — запас на случай, когда turbo гоняет все пакеты разом: каждому
    // тесту нужна своя PGlite с миграциями, и при 8 параллельных пакетов
    // 20с не хватало (файл падал по таймауту, изолированно проходил).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
