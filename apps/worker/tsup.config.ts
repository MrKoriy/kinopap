import { defineConfig } from "tsup";

/**
 * Прод-сборка воркера: один ESM-бандл вместо транспиляции `tsx` на лету.
 *
 * Воркспейс-пакеты (@zal/*) экспортируют исходники .ts — их вшиваем в бандл.
 * Сторонние зависимости остаются внешними и грузятся из node_modules: tsup
 * по умолчанию не бандлит `dependencies`, поэтому всё, что импортируют
 * вшитые пакеты (drizzle-orm, pg, zod), обязано быть в dependencies воркера.
 */
export default defineConfig({
  // Все модули верхнего уровня — точки входа: автопилот запускает бэкфиллы
  // отдельными процессами (siblingScript), и им нужен свой файл в dist.
  entry: ["src/*.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  splitting: true,
  noExternal: [/^@zal\//],
});
