import type { FastifyInstance } from "fastify";
import { buildOpenApiSpec } from "../openapi";

const DOCS_HTML = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Зал API — документация</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b0b0f; color: #f2f2f5; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
    h1 { color: #e50914; }
    .endpoint { border: 1px solid #26262f; border-radius: 10px; padding: .75rem 1rem; margin: .5rem 0; }
    .method { font-weight: 700; color: #e50914; margin-right: .5rem; }
    .path { font-family: ui-monospace, monospace; }
    .summary { color: #9a9aa8; margin-top: .25rem; }
    a { color: #ff1f2b; }
  </style>
</head>
<body>
  <h1>Зал API</h1>
  <p>REST-спецификация: <a href="/openapi.json">openapi.json</a></p>
  <div id="list">Загрузка…</div>
  <script>
    fetch("/openapi.json").then(r => r.json()).then(spec => {
      const list = document.getElementById("list");
      list.innerHTML = "";
      for (const [path, ops] of Object.entries(spec.paths)) {
        for (const [method, op] of Object.entries(ops)) {
          const div = document.createElement("div");
          div.className = "endpoint";
          div.innerHTML = '<span class="method">' + method.toUpperCase() + '</span>' +
            '<span class="path">' + path + '</span>' +
            '<div class="summary">' + (op.summary || "") + '</div>';
          list.appendChild(div);
        }
      }
    });
  </script>
</body>
</html>`;

export async function docsRoutes(app: FastifyInstance): Promise<void> {
  const spec = buildOpenApiSpec();

  app.get("/openapi.json", async () => spec);
  app.get("/docs", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return DOCS_HTML;
  });
}
