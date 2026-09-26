/**
 * Тестовые помощники: генерация реального медиафайла через ffmpeg
 * и герметичная БД (PGlite) с миграциями.
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsDir, schema } from "@zal/db";

const execFileAsync = promisify(execFile);

export async function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export const SAMPLE_SRT = `1
00:00:00,000 --> 00:00:01,500
Привет, мир

2
00:00:01,500 --> 00:00:02,000
Тест субтитров
`;

export interface TestMedia {
  dir: string;
  /** 2 секунды 1280x720, h264 + aac. */
  videoPath: string;
  /** Внешние субтитры рядом с видео. */
  subPath: string;
  /** mp4 со встроенным субтреком (mov_text, rus). */
  embeddedPath: string;
}

export async function makeTestMedia(): Promise<TestMedia> {
  const dir = await makeTmpDir("zal-media-");
  const videoPath = path.join(dir, "sample.mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=duration=2:size=1280x720:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    videoPath,
  ]);

  const subPath = path.join(dir, "sample.srt");
  await writeFile(subPath, SAMPLE_SRT, "utf8");

  const embeddedPath = path.join(dir, "embedded.mp4");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=duration=2:size=1280x720:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-i", subPath,
    "-map", "0:v", "-map", "1:a", "-map", "2:s",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-c:s", "mov_text",
    "-metadata:s:s:0", "language=rus",
    embeddedPath,
  ]);

  return { dir, videoPath, subPath, embeddedPath };
}

export type TestDb = PgliteDatabase<typeof schema>;

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsDir });
  return db;
}

/** Конфиг ffmpeg для тестов: ultrafast, короткие сегменты. */
export const TEST_FFMPEG = { preset: "ultrafast", crf: 30, hlsTime: 2 } as const;
