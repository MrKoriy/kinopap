import { describe, expect, it, vi } from "vitest";
import {
  AniListClient,
  type AniMedia,
  creditsToRows,
  franchiseRootId,
  neighbours,
  orderFranchise,
  parseTmdbCredits,
  pickSearchHit,
  tmdbKindOf,
} from "../src/index";

describe("parseTmdbCredits", () => {
  it("фильм: топ актёров по order, режиссёр и композитор из crew", () => {
    const cast = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `A${i}`, order: 24 - i, character: `C${i} (voice)` }));
    const res = parseTmdbCredits({
      backdrop_path: "/bd.jpg",
      credits: {
        cast,
        crew: [
          { id: 100, name: "Dir", job: "Director" },
          { id: 101, name: "Comp", job: "Original Music Composer" },
          { id: 102, name: "Grip", job: "Grip" },
        ],
      },
    });
    const actors = res.people.filter((p) => p.role === "actor");
    expect(actors).toHaveLength(20);
    expect(actors[0]).toMatchObject({ name: "A24", ord: 0, character: "C24" });
    expect(res.people.find((p) => p.role === "director")?.name).toBe("Dir");
    expect(res.people.find((p) => p.role === "composer")?.name).toBe("Comp");
    expect(res.people.some((p) => p.name === "Grip")).toBe(false);
    const rows = creditsToRows(res);
    expect(rows.backdropUrl).toBe("https://image.tmdb.org/t/p/w1280/bd.jpg");
  });

  it("сериал: aggregate_credits, роль — с наибольшим числом серий, режиссёр — создатель", () => {
    const res = parseTmdbCredits({
      aggregate_credits: {
        cast: [{ id: 1, name: "Actor", order: 0, roles: [{ character: "Minor", episode_count: 1 }, { character: "Main", episode_count: 30 }] }],
        crew: [{ id: 5, name: "Ep Director", jobs: [{ job: "Writer", episode_count: 2 }] }],
      },
      created_by: [{ id: 9, name: "Creator", profile_path: "/c.jpg" }],
    });
    expect(res.people.find((p) => p.role === "actor")?.character).toBe("Main");
    expect(res.people.find((p) => p.role === "director")).toMatchObject({ name: "Creator", photoPath: "/c.jpg" });
    expect(res.people.find((p) => p.role === "writer")?.name).toBe("Ep Director");
  });

  it("tmdbKindOf: tmdb_type важнее типа карточки", () => {
    expect(tmdbKindOf({ type: "anime", tmdbType: "movie" })).toBe("movie");
    expect(tmdbKindOf({ type: "anime" })).toBe("tv");
    expect(tmdbKindOf({ type: "movie", tmdbType: null })).toBe("movie");
  });
});

const media = (id: number, year: number, format: string, rel: Array<[string, number]> = [], romaji = `T${id}`): AniMedia => ({
  id,
  title: { romaji },
  format,
  type: "ANIME",
  startDate: { year, month: 1, day: 1 },
  relations: { edges: rel.map(([relationType, nid]) => ({ relationType, node: { id: nid, type: "ANIME" } })) },
});

describe("AniList", () => {
  it("порядок частей: по дате, при равной — ТВ раньше фильма; музыка выкинута", () => {
    const ordered = orderFranchise([media(3, 2015, "MOVIE"), media(2, 2015, "TV"), media(1, 2013, "TV"), media(4, 2014, "MUSIC")]);
    expect(ordered.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(franchiseRootId(ordered)).toBe(1);
  });

  it("соседи — только по связям франшизы и не манга", () => {
    const m = media(1, 2013, "TV", [["SEQUEL", 2], ["CHARACTER", 3], ["ADAPTATION", 4], ["SIDE_STORY", 5]]);
    expect(neighbours(m)).toEqual([2, 5]);
  });

  it("pickSearchHit: нужно совпадение названия и год ±1", () => {
    const hits = [media(10, 2010, "TV", [], "Other"), media(11, 2013, "TV", [], "Shingeki no Kyojin")];
    expect(pickSearchHit(hits, { titles: ["Атака титанов", "Shingeki no Kyojin"], year: 2013 })?.id).toBe(11);
    expect(pickSearchHit(hits, { titles: ["Shingeki no Kyojin"], year: 2020 })).toBeNull();
    expect(pickSearchHit(hits, { titles: ["Атака титанов"], year: 2013 })).toBeNull();
  });

  it("клиент обходит граф уровнями и ждёт Retry-After на 429", async () => {
    const graph: Record<number, AniMedia> = {
      2: media(2, 2015, "TV", [["PREQUEL", 1], ["SEQUEL", 3]]),
      3: media(3, 2017, "MOVIE", [["PREQUEL", 2]]),
    };
    let calls = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
      const { variables } = JSON.parse(String(init?.body)) as { variables: { ids: number[] } };
      return Response.json({ data: { Page: { media: variables.ids.map((id) => graph[id]).filter(Boolean) } } });
    });
    const client = new AniListClient({ fetch: fetchMock as unknown as typeof fetch, intervalMs: 0 });
    const nodes = await client.franchise(media(1, 2013, "TV", [["SEQUEL", 2]]));
    expect(nodes.map((n) => n.id).sort()).toEqual([1, 2, 3]);
    expect(calls).toBe(3); // 429 + уровень {2} + уровень {3}
  });
});
