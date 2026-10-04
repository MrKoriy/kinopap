import { fileURLToPath } from "node:url";

/**
 * Путь к соседнему скрипту воркера и аргументы его запуска.
 *
 * Из исходников (`tsx src/index.ts`) скрипт — `src/<name>.ts`, а запускать
 * его нужно тем же загрузчиком tsx (он в process.execArgv). В прод-бандле
 * (`node dist/index.js`) каждый модуль верхнего уровня собран в
 * `dist/<name>.js`, и execArgv пуст — обычный node.
 *
 * `baseUrl` — import.meta.url вызывающего модуля верхнего уровня: у бандла
 * все точки входа и чанки лежат в одном каталоге dist/.
 */
export function siblingScript(baseUrl: string, name: string): { path: string; args: string[] } {
  const ext = new URL(baseUrl).pathname.endsWith(".ts") ? ".ts" : ".js";
  const path = fileURLToPath(new URL(`./${name}${ext}`, baseUrl));
  return { path, args: [...process.execArgv, path] };
}
