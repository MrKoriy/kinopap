import { describe, expect, it } from "vitest";
import { streamHashFromUrl, streamReportRequestSchema } from "../src/stream";

const HEX = "ABCDEF0123456789abcdef0123456789abcdef01";

describe("streamHashFromUrl", () => {
  it("gst, подписанный gst-s и прямой stream", () => {
    expect(streamHashFromUrl(`/gst/${HEX}/master.m3u8?index=2&audio=0`)).toBe(HEX.toLowerCase());
    expect(streamHashFromUrl(`/gst-s/1760000000/AbC_-x/${HEX}/master.m3u8?index=1`)).toBe(
      HEX.toLowerCase(),
    );
    expect(streamHashFromUrl(`https://x.test/stream/Film.mkv?link=${HEX}&index=3&play`)).toBe(
      HEX.toLowerCase(),
    );
  });

  it("магнит в link", () => {
    const magnet = encodeURIComponent(`magnet:?xt=urn:btih:${HEX}&dn=x`);
    expect(streamHashFromUrl(`/stream?link=${magnet}&index=1&play`)).toBe(HEX.toLowerCase());
  });

  it("не торрент — null", () => {
    expect(streamHashFromUrl("https://cache.libria.fun/videos/ep1/index.m3u8")).toBeNull();
    expect(streamHashFromUrl("/media/42/master.m3u8")).toBeNull();
    expect(streamHashFromUrl(null)).toBeNull();
  });
});

describe("streamReportRequestSchema", () => {
  it("принимает причину и хеш, отвергает мусорный хеш", () => {
    expect(streamReportRequestSchema.parse({ reason: "wrong_episode", hash: HEX }).reason).toBe(
      "wrong_episode",
    );
    expect(() => streamReportRequestSchema.parse({ reason: "not_playing", hash: "zzz" })).toThrow();
    expect(() => streamReportRequestSchema.parse({ reason: "boom" })).toThrow();
  });
});
