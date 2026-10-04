import { getSyncState, listSerialsBehindTmdb, recordSyncRun, rumEvents, rumSummary } from "@zal/db";
import { describe, expect, it } from "vitest";
import { normalizePage } from "../src/routes/metrics";
import { makeOwnerWithInvite, memberAuth } from "./fixtures";
import { createTestApp } from "./setup";

describe("RUM-метрики", () => {
  it("принимает батч sendBeacon (text/plain), нормализует маршрут", async () => {
    const { app, db } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/metrics",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify({
        events: [
          { name: "LCP", value: 1800, page: "/item/123", rating: "good" },
          { name: "TTFF", value: 2400, page: "/watch/5/77", itemId: 5, meta: { cold: true, src: "live" } },
          { name: "TTFF", value: 600, page: "/watch/5/78", itemId: 5, meta: { cold: false, src: "db" } },
        ],
      }),
    });
    expect(res.statusCode).toBe(204);
    const rows = await db.select().from(rumEvents);
    expect(rows.map((r) => r.page).sort()).toEqual(["/item/[id]", "/watch/[id]/[id]", "/watch/[id]/[id]"]);

    const s = await rumSummary(db, 24);
    expect(s.metrics.find((m) => m.name === "LCP")).toMatchObject({ count: 1, p50: 1800, goodShare: 1 });
    expect(s.ttff).toMatchObject({ starts: 2, cold: 1, coldShare: 0.5, p50Cold: 2400, p50Warm: 600 });
  });

  it("мусор — 400, сводка — только владельцу", async () => {
    const { app, db } = await createTestApp();
    const bad = await app.inject({
      method: "POST",
      url: "/v1/metrics",
      payload: { events: [{ name: "EVIL", value: 1 }] },
    });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/metrics/summary" })).statusCode).toBe(401);
    const member = await memberAuth(app, db);
    expect((await app.inject({ method: "GET", url: "/v1/metrics/summary", headers: member })).statusCode).toBe(403);
    await makeOwnerWithInvite(db);
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "owner@zal.local", password: "owner-password-1" },
    });
    const token = (login.json() as { tokens: { accessToken: string } }).tokens.accessToken;
    await recordSyncRun(db, "tmdb-changes", { ok: true, cursor: "2026-10-05T00:00:00.000Z", stats: { movie: 1 } });
    const ok = await app.inject({
      method: "GET",
      url: "/v1/metrics/summary?hours=48",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { rum: { hours: number }; sync: Array<{ key: string }> };
    expect(body.rum.hours).toBe(48);
    expect(body.sync.map((s) => s.key)).toEqual(["tmdb-changes"]);
  });

  it("Server-Timing: время запроса в API", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(String(res.headers["server-timing"])).toMatch(/^app;dur=\d+(\.\d)?$/);
  });

  it("normalizePage", () => {
    expect(normalizePage("/item/42?x=1")).toBe("/item/[id]");
    expect(normalizePage("/")).toBe("/");
    expect(normalizePage(undefined)).toBeNull();
  });
});

describe("sync_state", () => {
  it("неудача не двигает курсор, успех — двигает", async () => {
    const { db } = await createTestApp();
    await recordSyncRun(db, "k", { ok: true, cursor: "A" });
    await recordSyncRun(db, "k", { ok: false, error: "boom" });
    let st = await getSyncState(db, "k");
    expect(st).toMatchObject({ cursor: "A", error: "boom" });
    await recordSyncRun(db, "k", { ok: true, cursor: "B", stats: { n: 1 } });
    st = await getSyncState(db, "k");
    expect(st).toMatchObject({ cursor: "B", error: null, stats: { n: 1 } });
    expect(await listSerialsBehindTmdb(db, 10)).toEqual([]);
  });
});
