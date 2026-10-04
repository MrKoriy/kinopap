import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...rest }: React.ComponentProps<"a"> & { prefetch?: boolean }) => {
    void prefetch;
    return (
      <a href={typeof href === "string" ? href : "#"} {...rest}>
        {children}
      </a>
    );
  },
}));

const auth = vi.hoisted(() => ({ state: { api: null as unknown, isAuthed: false, user: null as unknown, ready: true } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => auth.state, useOptionalAuth: () => auth.state }));

import { castContentType } from "@/components/player/cast";
import { Recommendations } from "@/components/recommendations";
import { reportError } from "@/lib/errors";
import { urlBase64ToUint8Array } from "@/lib/push";

afterEach(cleanup);

const summary = (id: number) => ({
  id,
  type: "movie",
  subtype: null,
  title: `Фильм ${id}`,
  originalTitle: null,
  year: 2020,
  plot: null,
  cast: [],
  director: [],
  duration: { average: null, total: null },
  langs: 0,
  ac3: false,
  quality: null,
  genres: [],
  countries: [],
  imdb: { id: null, rating: null, votes: null },
  kinopoisk: { id: null, rating: null, votes: null },
  tmdb: { id: null, rating: null, votes: null },
  rating: 7,
  votes: { positive: 0, negative: 0, total: 0 },
  views: 0,
  finished: null,
  advert: false,
  posters: { small: null, medium: null, big: null },
  trailer: { id: null, url: null },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

describe("фаза 4: утилиты", () => {
  it("тип потока для Chromecast", () => {
    expect(castContentType("https://z/gst/abc/master.m3u8")).toBe("application/x-mpegURL");
    expect(castContentType("https://z/stream?link=x&index=1&play")).toBe("video/mp4");
  });

  it("VAPID-ключ base64url → байты", () => {
    expect([...urlBase64ToUint8Array("AQID_w")]).toEqual([1, 2, 3, 255]);
  });

  it("репортёр ошибок: sendBeacon, без повторов одного текста", () => {
    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    reportError(new TypeError("boom"));
    reportError(new TypeError("boom"));
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(String(beacon.mock.calls[0]![0])).toMatch(/\/v1\/errors$/);
  });
});

describe("Recommendations", () => {
  it("гостю ничего", () => {
    auth.state.api = null;
    auth.state.isAuthed = false;
    const { container } = render(<Recommendations />);
    expect(container.innerHTML).toBe("");
  });

  it("залогиненному — лента из API", async () => {
    auth.state.isAuthed = true;
    auth.state.api = {
      getRecommendations: vi.fn().mockResolvedValue({ items: [1, 2, 3, 4, 5].map(summary) }),
      listFavorites: vi.fn().mockResolvedValue({ items: [] }),
      getFavoritesBatch: vi.fn().mockResolvedValue({ items: [] }),
    };
    render(<Recommendations />);
    await waitFor(() => expect(screen.getByTestId("recommendations")).toBeDefined());
    expect(screen.getByText("Рекомендуем вам")).toBeDefined();
  });
});

describe("онлайн-балансеры", () => {
  const source = (label: string, url: string) => ({ provider: "kodik", label, url, quality: "720p", lastSeason: null, lastEpisode: null });

  it("кнопка «Онлайн» появляется только при найденных источниках", async () => {
    const { OnlineButton } = await import("@/components/online-player");
    auth.state.api = { getOnlineSources: vi.fn().mockResolvedValue({ enabled: true, sources: [] }) };
    const { unmount } = render(<OnlineButton itemId={5} />);
    await waitFor(() => expect(auth.state.api).toBeTruthy());
    expect(screen.queryByTestId("online-button")).toBeNull();
    unmount();
    auth.state.api = { getOnlineSources: vi.fn().mockResolvedValue({ enabled: true, sources: [source("Дубляж", "https://k.test/1")] }) };
    render(<OnlineButton itemId={5} />);
    expect((await screen.findByTestId("online-button")).getAttribute("href")).toBe("/watch/5/online");
  });

  it("плеер: iframe первого источника, переключение озвучки", async () => {
    const { OnlinePlayer } = await import("@/components/online-player");
    auth.state.api = {
      getOnlineSources: vi.fn().mockResolvedValue({
        enabled: true,
        sources: [source("Дубляж", "https://k.test/1"), source("Гоблин", "https://k.test/2")],
      }),
    };
    render(<OnlinePlayer itemId={5} torrentHref="/watch/5/77" />);
    const iframe = await screen.findByTestId("online-iframe");
    expect((iframe).getAttribute("src")).toBe("https://k.test/1");
    screen.getAllByTestId("online-source")[1]!.click();
    await waitFor(() => expect((screen.getByTestId("online-iframe")).getAttribute("src")).toBe("https://k.test/2"));
  });

  it("плеер: пусто — предлагает торрент; сбой клиента не роняет", async () => {
    const { OnlinePlayer } = await import("@/components/online-player");
    auth.state.api = {};
    render(<OnlinePlayer itemId={5} torrentHref="/watch/5/77" />);
    expect(await screen.findByTestId("online-empty")).toBeTruthy();
  });
});
