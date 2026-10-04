import { describe, expect, it } from "vitest";
import { createTestApp } from "./setup";

describe("сжатие ответов", () => {
  it("большие JSON-ответы уходят в brotli, если клиент его принимает", async () => {
    const { app } = await createTestApp();
    // openapi.json — заведомо больше порога в 1 КБ и не зависит от данных.
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
  });

  it("без Accept-Encoding ответ не сжимается", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(() => res.json()).not.toThrow();
  });
});
