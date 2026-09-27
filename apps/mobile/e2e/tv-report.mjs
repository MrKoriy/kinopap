#!/usr/bin/env node
/**
 * Собирает отчёт из скриншотов `e2e/tv-smoke.sh` в один HTML-файл, вшивая
 * картинки в base64. Так отчёт открывается откуда угодно (и в превью Freebuff)
 * без статического сервера: один файл, никаких соседних ассетов.
 *
 *   node e2e/tv-report.mjs [каталог_скриншотов] [куда_писать]
 *
 * По умолчанию: /tmp/zal-tv-shots → тот же каталог, файл index.html.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const src = resolve(process.argv[2] ?? "/tmp/zal-tv-shots");
const outDir = resolve(process.argv[3] ?? src);

/** Человеческие подписи к кадрам смоука; чего нет в таблице — подписываем именем. */
const CAPTIONS = {
  "tv-home": "Лончер → приложение: ленты, постеры, «Войти»",
  "tv-focus": "D-pad: фокус подсвечен кольцом на карточке",
  "tv-item": "DPAD_CENTER на карточке → страница тайтла, фокус сразу на «Смотреть»",
  "tv-player": "Плеер открылся (первый кадр)",
  "tv-player2": "Играет: таймер дошёл до конца 12-секундного клипа",
};

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const shots = readdirSync(src)
  .filter((f) => f.toLowerCase().endsWith(".png"))
  .sort();

if (shots.length === 0) {
  console.error(`нет скриншотов в ${src} — сначала прогони e2e/tv-smoke.sh`);
  process.exit(1);
}

const figures = shots
  .map((file) => {
    const name = file.replace(/\.png$/i, "");
    const b64 = readFileSync(join(src, file)).toString("base64");
    const caption = CAPTIONS[name] ?? name;
    return `      <figure>
        <img src="data:image/png;base64,${b64}" alt="${esc(caption)}" />
        <figcaption>${esc(name)} — ${esc(caption)}</figcaption>
      </figure>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Зал — Android TV smoke</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        padding: 32px;
        background: #0b0b0f;
        color: #f2f2f2;
        font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      h1 { font-size: 20px; margin: 0 0 6px; font-weight: 700; }
      p.meta { color: #9a9aa5; max-width: 900px; margin: 0 0 28px; }
      code { color: #f0a0a0; }
      .grid { display: flex; flex-wrap: wrap; gap: 24px; }
      figure { margin: 0; }
      img {
        width: 480px;
        max-width: 100%;
        border-radius: 12px;
        border: 1px solid #26262e;
        background: #000;
        display: block;
      }
      figcaption { color: #9a9aa5; font-size: 13px; margin-top: 8px; }
    </style>
  </head>
  <body>
    <h1>Зал на Android TV — прогон пультом</h1>
    <p class="meta">
      Release-APK (<code>app-release.apk</code>) стоит на TV-эмуляторе
      (<code>tv_1080p</code>, arm64, Android TV) и запускается как обычное
      TV-приложение из лончера. Ходили D-pad'ом: <code>Down</code> по лентам →
      <code>DPAD_CENTER</code> открывает тайтл → <code>DPAD_CENTER</code> на
      «Смотреть» уводит в плеер. Кадры: ${shots.length}.
    </p>
    <div class="grid">
${figures}
    </div>
  </body>
</html>
`;

mkdirSync(outDir, { recursive: true });
const target = join(outDir, "index.html");
writeFileSync(target, html);
console.log(`${shots.length} кадров → ${target}`);
