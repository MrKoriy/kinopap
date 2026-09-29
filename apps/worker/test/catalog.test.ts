/**
 * Валидация спеки catalog-джоб: мусорная спека подтверждается и не
 * запускает fill (зеркало api-схемы discovery).
 */
import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import { type CatalogFillDeps, catalogFillSpecSchema, handleCatalogJob } from "../src/catalog";

function fakeDeps() {
  const specs: unknown[] = [];
  const deps: CatalogFillDeps = {
    runCatalogFill: async (spec, onProgress) => {
      specs.push(spec);
      onProgress({
        phase: "done",
        fetched: 0,
        processed: 0,
        added: 0,
        skipped: 0,
        total: 0,
        sources: [],
      });
      return {
        phase: "done",
        fetched: 0,
        processed: 0,
        added: 0,
        skipped: 0,
        total: 0,
        sources: [],
        durationMs: 1,
      };
    },
  };
  return { deps, specs };
}

function asJob(data: unknown, progress: unknown[] = []): Job {
  return {
    data,
    id: "42",
    updateProgress: async (p: unknown) => {
      progress.push(p);
      return {} as never;
    },
  } as unknown as Job;
}

describe("catalogFillSpecSchema", () => {
  it("принимает валидную спеку из api (buildFillSpec)", () => {
    const parsed = catalogFillSpecSchema.safeParse({
      years: [2020, 2021],
      yearPages: 5,
      genreMatrix: true,
      lists: true,
      collections: ["Dune Collection"],
      countries: ["KR"],
      anime: true,
      animeLimit: 500,
      dedupe: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("отклоняет мусор: типы и границы", () => {
    expect(catalogFillSpecSchema.safeParse(null).success).toBe(false);
    expect(catalogFillSpecSchema.safeParse({ years: 2020 }).success).toBe(false);
    expect(
      catalogFillSpecSchema.safeParse({ yearPages: 11 }).success,
    ).toBe(false);
    expect(
      catalogFillSpecSchema.safeParse({ countries: ["russ"] }).success,
    ).toBe(false);
    expect(
      catalogFillSpecSchema.safeParse({ years: [1949] }).success,
    ).toBe(false);
  });
});

describe("handleCatalogJob", () => {
  it("валидная спека запускает fill и гоняет прогресс", async () => {
    const { deps, specs } = fakeDeps();
    const progress: unknown[] = [];
    const summary = await handleCatalogJob(deps, asJob(
      { spec: { years: [2024], anime: false } },
      progress,
    ));
    expect(specs).toEqual([{ years: [2024], anime: false }]);
    expect(summary?.phase).toBe("done");
    expect(progress).toHaveLength(1);
  });

  it("невалидная джоба: acknowledge без запуска fill", async () => {
    const { deps, specs } = fakeDeps();
    const result = await handleCatalogJob(deps, asJob({ spec: { years: "all" } }));
    expect(result).toBeNull();
    expect(specs).toEqual([]);
  });

  it("джоба без data/spec: acknowledge без запуска fill", async () => {
    const { deps, specs } = fakeDeps();
    const result = await handleCatalogJob(deps, asJob(undefined));
    expect(result).toBeNull();
    expect(specs).toEqual([]);
  });
});
