import { describe, expect, it } from "vitest";
import { isReadableTitle, pickLocalizedTitle } from "../src/lib/localize-titles";

const tr = (iso: string, country: string, name: string) => ({ iso_639_1: iso, iso_3166_1: country, data: { name } });

describe("localize-titles", () => {
  it("ru → en(US) → любое латиницей", () => {
    expect(pickLocalizedTitle([tr("en", "GB", "Fractale UK"), tr("ru", "RU", "Фрактал"), tr("ja", "JP", "フラクタル")])).toBe("Фрактал");
    expect(pickLocalizedTitle([tr("en", "GB", "Fractale UK"), tr("en", "US", "Fractale"), tr("ja", "JP", "フラクタル")])).toBe("Fractale");
    expect(pickLocalizedTitle([tr("fr", "FR", "Fractale FR"), tr("ja", "JP", "フラクタル")])).toBe("Fractale FR");
    expect(pickLocalizedTitle([tr("ru", "RU", ""), tr("ja", "JP", "フラクタル")])).toBeNull();
  });
  it("читаемость названия", () => {
    expect(isReadableTitle("フラクタル")).toBe(false);
    expect(isReadableTitle("2012")).toBe(true);
    expect(isReadableTitle("Блич")).toBe(true);
  });
});
