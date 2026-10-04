import { describe, expect, it, vi } from "vitest";
import { buildSentryEnvelope, parseSentryDsn, sendSentryEvent, stackFrames } from "../src/sentry";

describe("sentry-lite", () => {
  it("DSN → endpoint envelope", () => {
    expect(parseSentryDsn("https://abc123@o42.ingest.sentry.io/77")).toEqual({
      url: "https://o42.ingest.sentry.io/api/77/envelope/",
      publicKey: "abc123",
    });
    expect(parseSentryDsn("")).toBeNull();
    expect(parseSentryDsn("not a url")).toBeNull();
  });

  it("стек → кадры, место ошибки последним", () => {
    const frames = stackFrames("TypeError: x\n    at inner (/app/a.js:10:5)\n    at /app/node_modules/b.js:1:2");
    expect(frames).toHaveLength(2);
    expect(frames.at(-1)).toMatchObject({ function: "inner", lineno: 10, in_app: true });
    expect(frames[0]).toMatchObject({ in_app: false });
  });

  it("конверт: три строки JSON, тип исключения из сообщения", () => {
    const lines = buildSentryEnvelope({ message: "TypeError: boom", release: "r1" }).split("\n");
    expect(lines).toHaveLength(3);
    const ev = JSON.parse(lines[2]!);
    expect(ev.exception.values[0]).toMatchObject({ type: "TypeError", value: "boom" });
    expect(ev.release).toBe("r1");
  });

  it("без DSN не шлёт, сбой сети не бросает", async () => {
    const f = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await sendSentryEvent(null, { message: "x" }, f)).toBe(false);
    expect(await sendSentryEvent(parseSentryDsn("https://k@s.io/1"), { message: "x" }, f)).toBe(false);
    expect(f).toHaveBeenCalledOnce();
  });
});
