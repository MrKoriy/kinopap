/**
 * Каналы уведомлений, ошибки веба, рекомендации и /metrics (Prometheus).
 */
import { consumeTelegramLinkCode, errorEvents, listNotifyChannels } from "@zal/db";
import { describe, expect, it } from "vitest";
import { memberAuth } from "./fixtures";
import { createTestApp } from "./setup";

const BOT = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_BOT_NAME: "@kinopap_bot", WEBPUSH_PUBLIC_KEY: "BPub" };

describe("уведомления", () => {
  it("config: без бота и ключа — null", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/v1/notify/config" });
    expect(res.json()).toEqual({ telegramBot: null, webpushKey: null });
  });

  it("Telegram: ссылка с кодом → привязка → список → удаление", async () => {
    const { app, db } = await createTestApp({ env: BOT });
    expect((await app.inject({ method: "GET", url: "/v1/notify/config" })).json()).toEqual({
      telegramBot: "kinopap_bot",
      webpushKey: "BPub",
    });
    const auth = await memberAuth(app, db);
    expect((await app.inject({ method: "POST", url: "/v1/notify/telegram/link" })).statusCode).toBe(401);
    const link = await app.inject({ method: "POST", url: "/v1/notify/telegram/link", headers: auth });
    expect(link.statusCode).toBe(200);
    const { url, code } = link.json() as { url: string; code: string };
    expect(url).toBe(`https://t.me/kinopap_bot?start=${code}`);
    const userId = await consumeTelegramLinkCode(db, code, "999", "Лео");
    expect(userId).not.toBeNull();
    const list = await app.inject({ method: "GET", url: "/v1/notify/channels", headers: auth });
    const channels = (list.json() as { channels: Array<{ id: number; kind: string }> }).channels;
    expect(channels.map((c) => c.kind)).toEqual(["telegram"]);
    const del = await app.inject({ method: "DELETE", url: `/v1/notify/channels/${channels[0]!.id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    expect(await listNotifyChannels(db, userId!)).toEqual([]);
  });

  it("web push: только https-endpoint", async () => {
    const { app, db } = await createTestApp({ env: BOT });
    const auth = await memberAuth(app, db);
    const keys = { p256dh: "B".repeat(40), auth: "a".repeat(16) };
    const bad = await app.inject({ method: "POST", url: "/v1/notify/webpush", headers: auth, payload: { endpoint: "http://x.test/1", keys } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: "/v1/notify/webpush",
      headers: { ...auth, "user-agent": "Mozilla/5.0 Firefox/131.0" },
      payload: { endpoint: "https://push.test/abc", keys },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ channel: { kind: "webpush", label: "Firefox" } });
  });
});

describe("ошибки и метрики", () => {
  it("POST /v1/errors пишет ленту, шум расширений отбрасывает", async () => {
    const { app, db } = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/errors",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify({
        errors: [
          { message: "TypeError: x is undefined", stack: "at f (https://zal/_next/a.js:1:2)", page: "/item/5" },
          { message: "ResizeObserver loop limit exceeded" },
        ],
      }),
    });
    expect(res.statusCode).toBe(204);
    const rows = await db.select().from(errorEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "web", page: "/item/[id]" });
  });

  it("GET /metrics — формат Prometheus", async () => {
    const { app } = await createTestApp();
    await app.inject({ method: "GET", url: "/v1/genres" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('kinopap_http_requests_total{pm="0",method="GET",route="/v1/genres",status="2xx"} 1');
    expect(res.body).toContain("kinopap_process_rss_bytes");
  });

  it("рекомендации: гостю 401, без истории — пусто", async () => {
    const { app, db } = await createTestApp();
    expect((await app.inject({ method: "GET", url: "/v1/recommendations" })).statusCode).toBe(401);
    const auth = await memberAuth(app, db);
    const res = await app.inject({ method: "GET", url: "/v1/recommendations", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });
});
