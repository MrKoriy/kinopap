/**
 * E2E-обвязка «Зал»: реальный API на PGlite + реальный ingest через ffmpeg
 * + раздача медиафайлов. Всё в одном процессе на :3001 — веб в тестах
 * ходит сюда же (NEXT_PUBLIC_API_URL по умолчанию — http://localhost:3001).
 */
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import {
  createUser,
  type Db,
  hashPassword,
  migrationsDir,
  schema,
} from "@zal/db";
import {
  LocalFolderConnector,
  LocalStorage,
  runIngest,
  UrlSourceConnector,
} from "@zal/ingest";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { buildApp } from "../../api/src/app";
import { loadConfig } from "../../api/src/config";

const execFileAsync = promisify(execFile);
const PORT = 3001;
// Публичная база для медиа: браузеру хватает localhost, а клиенту на телефоне
// или в эмуляторе Android нужен адрес хоста — 10.0.2.2 для эмулятора, IP
// машины для живого устройства → ZAL_E2E_PUBLIC_BASE=http://10.0.2.2:3001/media.
const PUBLIC_BASE =
  process.env.ZAL_E2E_PUBLIC_BASE?.replace(/\/$/, "") ??
  `http://localhost:${PORT}/media`;

export const E2E_USER = { email: "e2e@zal.dev", password: "e2e-password-123" };

const MIME: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
};

async function makeSampleMedia(dir: string): Promise<string> {
  const videoPath = path.join(dir, "sample.mp4");
  // Два дубляжа с разными тонами (300Гц / 3000Гц): переключение дорожки
  // можно доказать частотным анализом реального аудиовыхода.
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=duration=12:size=1280x720:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=3000:duration=12",
    "-map", "0:v", "-map", "1:a", "-map", "2:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-metadata:s:a:0", "language=rus",
    "-metadata:s:a:0", "title=MVO Dublyazh",
    // mp4-муксер ffmpeg 7 не сохраняет title дорожки — имя едет в handler_name.
    "-metadata:s:a:0", "handler_name=MVO Dublyazh",
    "-metadata:s:a:1", "language=eng",
    "-metadata:s:a:1", "title=AVO Original",
    "-metadata:s:a:1", "handler_name=AVO Original",
    videoPath,
  ]);
  await writeFile(
    path.join(dir, "sample.srt"),
    "1\n00:00:01,000 --> 00:00:03,000\nПривет из субтитров\n\n2\n00:00:04,000 --> 00:00:06,000\nВторая реплика\n",
    "utf8",
  );
  return videoPath;
}

async function main(): Promise<void> {
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "zal-e2e-media-"));
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "zal-e2e-src-"));

  // 1. Тестовое медиа + реальный ingest (ffprobe → ffmpeg → публикация).
  await makeSampleMedia(sourceDir);
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: migrationsDir });

  const storage = new LocalStorage(mediaRoot, PUBLIC_BASE);
  const ffmpeg = { preset: "ultrafast", crf: 30, hlsTime: 2 };
  const result = await runIngest(
    {
      db,
      storage,
      connectors: {
        local: new LocalFolderConnector(sourceDir, ffmpeg),
        url: new UrlSourceConnector({ ...ffmpeg, allowPrivateHosts: true }),
      },
      ffmpeg,
    },
    {
      source: { type: "local", ref: "sample.mp4", subtitleRefs: ["sample.srt"] },
      item: {
        type: "movie",
        title: "Тестовый фильм",
        year: 2026,
        plot: "Тестовый тайтл для e2e-прогона плеера.",
      },
    },
  );

  // 2. Пользователь для входа через UI.
  await createUser(db, {
    email: E2E_USER.email,
    passwordHash: await hashPassword(E2E_USER.password),
    name: "E2E Тестер",
    role: "owner",
  });

  // 3. API + раздача медиа (один процесс, один порт).
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://e2e",
    JWT_SECRET: "e2e-secret-0123456789abcdef-0123456789",
    MEDIA_BASE_URL: PUBLIC_BASE,
    // Конкретные origin'ы: refresh-cookie требует credentials в CORS
    // (это же окружение использует мобильный e2e на :3002).
    CORS_ORIGIN: "http://localhost:3000,http://localhost:3002",
  });
  // ZAL_E2E_LOG=1 включает лог запросов (нужен, когда клиент — не браузер,
  // например симулятор iOS: иначе трафик приложения нигде не видно).
  const app = await buildApp({ db, config, logger: process.env.ZAL_E2E_LOG === "1" });

  app.get("/media/*", { config: { rateLimit: false } }, async (request, reply) => {
    const rel = (request.params as Record<string, string>)["*"] ?? "";
    const abs = path.resolve(mediaRoot, rel);
    console.log(`MEDIA ${request.method} raw=${request.url} rel=${rel}`);
    if (!abs.startsWith(path.resolve(mediaRoot) + path.sep)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      const st = await stat(abs);
      if (!st.isFile()) return reply.code(404).send({ error: "not found" });
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    reply.header("content-type", MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream");
    reply.header("access-control-allow-origin", "*");
    return reply.send(createReadStream(abs));
  });

  // 127.0.0.1 хватает и браузеру, и эмулятору (10.0.2.2 — это loopback хоста);
  // для живого устройства на LAN нужен ZAL_E2E_HOST=0.0.0.0.
  await app.listen({ port: PORT, host: process.env.ZAL_E2E_HOST ?? "127.0.0.1" });
  console.log(`e2e server ready on :${PORT} (item=${result.itemId}, media=${result.mediaId})`);
  console.log(`media base: ${PUBLIC_BASE}`);

  // Самопроверка: все файлы плеера реально отдаются. Не готов — не пускать тесты.
  const probeKeys = [
    result.masterKey,
    ...result.rungKeys,
    ...result.audioKeys,
    `${result.baseKey}/subs/external_0.vtt`,
    `${result.baseKey}/poster.jpg`,
    `${result.baseKey}/sprite.jpg`,
  ];
  let broken = 0;
  for (const key of probeKeys) {
    try {
      const res = await fetch(`${PUBLIC_BASE}/${key}`);
      console.log(`SELF-CHECK ${res.status} ${key}`);
      if (!res.ok) broken++;
    } catch (err) {
      console.log(`SELF-CHECK FAIL ${key}: ${String(err)}`);
      broken++;
    }
  }
  if (broken > 0) {
    console.error(`SELF-CHECK: ${broken} файлов не отдаются — харнесс не готов`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
