import { describe, expect, it } from "vitest";
import { assertSafeUrl, isPrivateIp, resolveRedirects } from "../src/connectors/url-source";

describe("SSRF-guard: isPrivateIp", () => {
  it.each([
    "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.127.255.254", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "2130706433", "0x7f000001", "0177.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::127.0.0.1",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "[::ffff:127.0.0.1]",
    "not-an-ip",
  ])("блокирует %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "пропускает публичный %s",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});

describe("SSRF-guard: assertSafeUrl", () => {
  it.each([
    "http://[::ffff:127.0.0.1]/a.mp4",
    "http://[::ffff:10.0.0.1]/a.mp4",
    "http://[::127.0.0.1]/a.mp4",
    "http://[64:ff9b::7f00:1]/a.mp4",
    "http://100.64.0.1/a.mp4",
    "http://0x7f.1/a.mp4",
    "http://localhost/a.mp4",
    "http://foo.localhost/a.mp4",
  ])("отклоняет %s", async (url) => {
    await expect(assertSafeUrl(url, {})).rejects.toThrow(/private address/);
  });

  it("публичный IP-литерал проходит без DNS", async () => {
    await expect(assertSafeUrl("https://1.1.1.1/a.mp4", {})).resolves.toBeInstanceOf(URL);
  });
});

describe("SSRF-guard: редиректы для ffprobe", () => {
  it("редирект на приватный адрес блокируется до ffprobe", async () => {
    const fakeFetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:8080/secret" },
      })) as unknown as typeof fetch;
    await expect(
      resolveRedirects({ fetch: fakeFetch }, "https://1.1.1.1/movie.mp4"),
    ).rejects.toThrow(/private address/);
  });

  it("цепочка публичных редиректов отдаёт финальный URL", async () => {
    let n = 0;
    const fakeFetch = (async () => {
      n += 1;
      return n === 1
        ? new Response(null, { status: 301, headers: { location: "https://8.8.8.8/final.mp4" } })
        : new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(resolveRedirects({ fetch: fakeFetch }, "https://1.1.1.1/movie.mp4")).resolves.toBe(
      "https://8.8.8.8/final.mp4",
    );
  });
});
