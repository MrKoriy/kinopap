import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ItemSummary, ProgressDto } from "@zal/api-client";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// next/link тянет роутер Next — в компонентных тестах он не нужен.
vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: React.ComponentProps<"a"> & { prefetch?: boolean }) => {
    void prefetch;
    return (
      <a href={typeof href === "string" ? href : "#"} {...rest}>
        {children}
      </a>
    );
  },
}));

// Лента читает api/isAuthed из useAuth — подменяем контекст, сеть не нужна.
const mocks = vi.hoisted(() => ({
  auth: {
    api: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
    isAuthed: false,
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => mocks.auth,
  useOptionalAuth: () => mocks.auth,
}));

import {
  ContinueWatching,
  matchContinueItems,
  selectContinueProgress,
} from "@/components/continue-watching";

afterEach(cleanup);

function makeProgress(over: Partial<ProgressDto> = {}): ProgressDto {
  return {
    mediaId: 500,
    itemId: 10,
    positionSeconds: 600,
    durationSeconds: 1200,
    status: "in_progress",
    updatedAt: "2026-09-29T10:00:00.000Z",
    ...over,
  };
}

function makeSummary(id: number, title: string): ItemSummary {
  return {
    id,
    type: "movie",
    subtype: null,
    title,
    originalTitle: null,
    year: 1979,
    plot: null,
    cast: [],
    director: [],
    duration: { average: 6180, total: 6180 },
    langs: 1,
    ac3: false,
    quality: 1080,
    genres: [],
    countries: [],
    imdb: { id: null, rating: null, votes: null },
    kinopoisk: { id: null, rating: null, votes: null },
    tmdb: { id: null, rating: null, votes: null },
    rating: 8.1,
    votes: { positive: 10, negative: 1, total: 11 },
    views: 100,
    finished: null,
    advert: false,
    posters: { small: null, medium: `http://cdn/p${id}.jpg`, big: null },
    trailer: { id: null, url: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("selectContinueProgress", () => {
  it("берёт только начатые записи и свежие первыми", () => {
    const rows = [
      makeProgress({ positionSeconds: 0 }), // не начато (0%)
      makeProgress({ positionSeconds: 1200 }), // досмотрено (100%)
      makeProgress({ itemId: 1, updatedAt: "2026-09-01T00:00:00Z" }),
      makeProgress({ itemId: 2, updatedAt: "2026-09-28T00:00:00Z" }),
    ];
    const picked = selectContinueProgress(rows);
    // Начатое: item 2 свежее item 1; не начатое и досмотренное отсеяны.
    expect(picked.map((p) => p.itemId)).toEqual([2, 1]);
  });

  it("несколько media одного тайтла схлопываются в самую свежую", () => {
    const rows = [
      makeProgress({ itemId: 5, mediaId: 501, updatedAt: "2026-09-20T00:00:00Z" }),
      makeProgress({ itemId: 5, mediaId: 502, updatedAt: "2026-09-25T00:00:00Z" }),
      makeProgress({ itemId: 6, mediaId: 601 }),
    ];
    const picked = selectContinueProgress(rows);
    expect(picked.map((p) => p.mediaId)).toEqual([601, 502]);
  });
});

describe("matchContinueItems", () => {
  it("матчит прогресс с карточками по id, пропуская отсутствующие", () => {
    const progress = [
      makeProgress({ itemId: 1, mediaId: 101 }),
      makeProgress({ itemId: 3, mediaId: 301 }),
      makeProgress({ itemId: 2, mediaId: 201 }),
    ];
    // Карточки приходят в порядке ids запроса — порядок прогресса важнее.
    const items = [makeSummary(2, "Б"), makeSummary(1, "А")];
    const entries = matchContinueItems(progress, items);
    expect(entries.map((e) => e.item.title)).toEqual(["А", "Б"]);
    expect(entries[0]!.progress.mediaId).toBe(101);
    // item 3 нет в ответе (тайтл удалён) — записи просто нет в ленте.
    expect(entries).toHaveLength(2);
  });
});

describe("ContinueWatching", () => {
  function mountAuthed(
    progressRows: ProgressDto[],
    summaries: ItemSummary[],
  ): { api: Record<string, ReturnType<typeof vi.fn>>; batches: number[][] } {
    const batches: number[][] = [];
    const api = {
      listProgress: vi.fn(async () => ({ items: progressRows })),
      getItemsSummary: vi.fn(async (ids: number[]) => {
        batches.push(ids);
        const byId = new Map(summaries.map((s) => [s.id, s]));
        return { items: ids.flatMap((id) => {
          const s = byId.get(id);
          return s ? [s] : [];
        }) };
      }),
      // Раньше лента делала до 8 getItem подряд — Regression-guard.
      getItem: vi.fn(),
    };
    mocks.auth.api = api;
    mocks.auth.isAuthed = true;
    return { api, batches };
  }

  it("рендерит ленту одним батч-запросом, без getItem на запись", async () => {
    const progress = [
      makeProgress({ itemId: 10, mediaId: 500, positionSeconds: 300 }),
      makeProgress({ itemId: 11, mediaId: 600, positionSeconds: 300 }),
    ];
    const { api, batches } = mountAuthed(progress, [
      makeSummary(10, "Сталкер"),
      makeSummary(11, "Солярис"),
    ]);
    render(<ContinueWatching />);

    await waitFor(() => expect(screen.getByTestId("continue-rail")).toBeDefined());
    // Один запрос с ids всех записей, getItem не зовётся вовсе.
    expect(batches).toEqual([[10, 11]]);
    expect(api.getItem).not.toHaveBeenCalled();

    const cards = screen.getAllByTestId("continue-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.getAttribute("href")).toBe("/watch/10/500");
    expect(cards[1]!.getAttribute("href")).toBe("/watch/11/600");
    expect(screen.getByText("Сталкер")).toBeDefined();
  });

  it("частичный ответ: карточки только для найденных тайтлов", async () => {
    const progress = [
      makeProgress({ itemId: 10, mediaId: 500, positionSeconds: 300 }),
      makeProgress({ itemId: 12, mediaId: 700, positionSeconds: 300 }),
    ];
    mountAuthed(progress, [makeSummary(10, "Сталкер")]);
    render(<ContinueWatching />);

    await waitFor(() => expect(screen.getByTestId("continue-rail")).toBeDefined());
    expect(screen.getAllByTestId("continue-card")).toHaveLength(1);
    expect(screen.queryByText("Сталкер")).not.toBeNull();
  });

  it("пустой ответ — лента скрыта", async () => {
    const progress = [makeProgress({ itemId: 10, positionSeconds: 300 })];
    const { api } = mountAuthed(progress, []);
    render(<ContinueWatching />);

    await waitFor(() => expect(api.getItemsSummary).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByTestId("continue-card")).toBeNull());
    expect(screen.queryByTestId("continue-rail")).toBeNull();
  });

  it("гость не ходит в API и ленту не видит", async () => {
    mocks.auth.api = { listProgress: vi.fn(), getItemsSummary: vi.fn(), getItem: vi.fn() };
    mocks.auth.isAuthed = false;
    render(<ContinueWatching />);

    await waitFor(() => expect(screen.queryByTestId("continue-rail")).toBeNull());
    expect(mocks.auth.api.listProgress).not.toHaveBeenCalled();
  });
});
