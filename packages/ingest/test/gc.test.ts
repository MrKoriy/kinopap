/**
 * GC хранилища: сироты ingest/* и jobs/* удаляются по возрасту и
 * ссылкам; рабочие каталоги zal-ingest-* в tmpdir чистятся по mtime.
 */
import { mkdir, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gcOrphanIngestDirs, gcStaleTmpDirs } from "../src";
import { createTestDb, makeTmpDir } from "./helpers";

const HOUR_MS = 60 * 60 * 1000;

/** Каталог с заданным mtime (старый — чтобы GC считал его сиротой). */
async function makeDir(
  root: string,
  name: string,
  ageMs: number,
): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const atime = new Date(Date.now() - ageMs);
  await utimes(dir, atime, atime);
  return dir;
}

describe("gcOrphanIngestDirs", () => {
  it("удаляет старые сироты ingest/* и jobs/*, свежие не трогает", async () => {
    const db = await createTestDb();
    const mediaRoot = await makeTmpDir("zal-gc-root-");

    const oldIngest = await makeDir(
      path.join(mediaRoot, "ingest"),
      "1000-old",
      2 * HOUR_MS,
    );
    const freshIngest = await makeDir(
      path.join(mediaRoot, "ingest"),
      "2000-fresh",
      5 * 60 * 1000,
    );
    const oldJob = await makeDir(
      path.join(mediaRoot, "jobs"),
      "transcode-1000",
      2 * HOUR_MS,
    );
    const freshJob = await makeDir(
      path.join(mediaRoot, "jobs"),
      "transcode-2000",
      5 * 60 * 1000,
    );

    const removed = await gcOrphanIngestDirs(db, mediaRoot);
    expect(removed).toContain("ingest/1000-old");
    expect(removed).toContain("jobs/transcode-1000");

    await expect(stat(oldIngest)).rejects.toThrow();
    await expect(stat(oldJob)).rejects.toThrow();
    await stat(freshIngest);
    await stat(freshJob);
  });

  it("отсутствующий корень jobs/ не ломает GC", async () => {
    const db = await createTestDb();
    const mediaRoot = await makeTmpDir("zal-gc-noroot-");
    await mkdir(path.join(mediaRoot, "ingest"), { recursive: true });

    const removed = await gcOrphanIngestDirs(db, mediaRoot);
    expect(removed).toEqual([]);
  });
});

describe("gcStaleTmpDirs", () => {
  it("чистит только zal-ingest-* старше часа", async () => {
    const tmpDir = await makeTmpDir("zal-gc-tmp-");
    const oldIngest = await makeDir(tmpDir, "zal-ingest-crash", 2 * HOUR_MS);
    const freshIngest = await makeDir(tmpDir, "zal-ingest-live", 5 * 60 * 1000);
    const oldOther = await makeDir(tmpDir, "zal-media-other", 2 * HOUR_MS);

    const removed = await gcStaleTmpDirs({ tmpDir });
    expect(removed).toEqual(["zal-ingest-crash"]);

    await expect(stat(oldIngest)).rejects.toThrow();
    await stat(freshIngest);
    await stat(oldOther);
  });

  it("несуществующий tmpDir — пустой результат, не ошибка", async () => {
    const removed = await gcStaleTmpDirs({
      tmpDir: path.join(await makeTmpDir("zal-gc-empty-"), "missing"),
    });
    expect(removed).toEqual([]);
  });
});
