/**
 * Catalog Daemon: расписание и запись итога прогона в sync_state.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { type Db, getSyncState, migrationsDir, schema } from "@zal/db";
import { TmdbClient } from "@zal/ingest";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daemonSchedules, runDaemonTask } from "../src/daemon";

let client: PGlite;
let db: Db;
beforeAll(async () => {
  client = new PGlite({ extensions: { pg_trgm } });
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: migrationsDir });
  db = d as unknown as Db;
});
afterAll(async () => {
  await client.close();
});

describe("daemonSchedules", () => {
  it("все задачи по умолчанию, DAEMON_SKIP выключает отдельные", () => {
    expect(daemonSchedules({}).map((s) => s.id)).toEqual([
      "tmdb-changes",
      "tmdb-feeds",
      "anilibria-updates",
      "metadata-gaps",
      "images-new",
    ]);
    const s = daemonSchedules({ DAEMON_SKIP: "images-new, tmdb-feeds" });
    expect(s.map((x) => x.id)).toEqual(["tmdb-changes", "anilibria-updates", "metadata-gaps"]);
    expect(s.find((x) => x.id === "tmdb-changes")?.everyMs).toBe(30 * 60 * 1000);
  });
});

describe("runDaemonTask", () => {
  it("tmdb-changes: курсор двигается после полного прохода", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ results: [], total_pages: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const now = new Date("2026-10-05T10:00:00Z");
    const stats = await runDaemonTask(
      {
        db,
        tmdbApiKey: "k",
        runScript: async () => 0,
        tmdb: new TmdbClient({ apiKey: "k", fetch: fetchFn, requestIntervalMs: 0 }),
        now: () => now,
      },
      "tmdb-changes",
    );
    expect(stats).toMatchObject({ movie: { changedAtTmdb: 0, ours: 0 }, tv: { changedAtTmdb: 0 } });
    const st = await getSyncState(db, "tmdb-changes");
    expect(st?.cursor).toBe(now.toISOString());
    expect(st?.lastOkAt).not.toBeNull();
  });

  it("сбой задачи пишет ошибку в sync_state и не роняет воркер", async () => {
    const stats = await runDaemonTask({ db, tmdbApiKey: "k", runScript: async () => 1 }, "images-new");
    expect(stats).toBeNull();
    const st = await getSyncState(db, "images-new");
    expect(st?.error).toContain("exited with 1");
    expect(st?.lastOkAt).toBeNull();
  });
});
