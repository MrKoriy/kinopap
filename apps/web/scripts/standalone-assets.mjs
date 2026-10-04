/**
 * postbuild: докладывает в standalone-сборку то, что Next туда не копирует, —
 * клиентские чанки (.next/static) и public/. Без них server.js отдаёт HTML,
 * а CSS/JS и иконки — 404.
 *
 * Монорепо: outputFileTracingRoot — корень репозитория, поэтому сервер лежит
 * в .next/standalone/apps/web/server.js, и статика — рядом с ним.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const standaloneApp = join(webDir, ".next", "standalone", "apps", "web");

if (!existsSync(join(standaloneApp, "server.js"))) {
  console.log("standalone-assets: standalone-сборки нет, пропускаю");
  process.exit(0);
}

const copies = [
  [join(webDir, ".next", "static"), join(standaloneApp, ".next", "static")],
  [join(webDir, "public"), join(standaloneApp, "public")],
];
for (const [from, to] of copies) {
  if (!existsSync(from)) continue;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}
console.log("standalone-assets: static и public скопированы");
