import { describe, expect, it } from "vitest";
import { countryName, extractCountries } from "../src/lib/countries-fill";

describe("countries-fill", () => {
  it("короткие русские названия", () => {
    expect(countryName("US")).toBe("США");
    expect(countryName("jp")).toBe("Япония");
    expect(countryName("HK")).toBe("Гонконг");
    expect(countryName("XX1")).toBeNull();
  });
  it("production_countries + origin_country без дублей", () => {
    expect(
      extractCountries({
        production_countries: [{ iso_3166_1: "JP" }, { iso_3166_1: "US" }],
        origin_country: ["JP"],
      }),
    ).toEqual(["Япония", "США"]);
    expect(extractCountries({})).toEqual([]);
  });
});
