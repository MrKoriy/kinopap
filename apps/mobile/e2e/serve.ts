/**
 * Раздача expo web-экспорта (dist-e2e) для e2e: обычные файлы + SPA-фолбэк
 * на index.html, чтобы клиентский роутер сам разобрал глубокие ссылки.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "dist-e2e");
// Именно ZAL_E2E_PORT: обычный PORT в окружении может быть занят/нулевой.
const port = Number(process.env.ZAL_E2E_PORT) || 3002;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

mkdirSync(root, { recursive: true });

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let filePath = path.join(root, decodeURIComponent(url.pathname));

  // Дир → index.html; статический маршрут → .html; остальное — SPA-фолбэк.
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!existsSync(filePath) && existsSync(`${filePath}.html`)) {
    filePath = `${filePath}.html`;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = path.join(root, "index.html");
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`mobile e2e static server: http://127.0.0.1:${port} → ${root}`);
});
