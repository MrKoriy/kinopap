import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../lib/format";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatRelativeTime", () => {
  it("свежая запись — «только что»", () => {
    expect(formatRelativeTime(ago(10_000), NOW)).toBe("только что");
  });

  it("минуты, часы и дни — в относительной форме", () => {
    expect(formatRelativeTime(ago(5 * 60_000), NOW)).toMatch(/5 минут/);
    expect(formatRelativeTime(ago(2 * 3_600_000), NOW)).toMatch(/2 час/);
    expect(formatRelativeTime(ago(3 * 86_400_000), NOW)).toMatch(/3 дн/);
  });

  it("старше недели — абсолютная дата", () => {
    const out = formatRelativeTime(ago(30 * 86_400_000), NOW);
    expect(out).toContain("2026");
    expect(out).not.toContain("назад");
  });

  it("мусорная дата — пусто", () => {
    expect(formatRelativeTime("не дата", NOW)).toBe("");
  });
});
