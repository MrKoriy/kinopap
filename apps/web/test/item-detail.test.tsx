import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ItemDetail, ItemProgressDto } from "@zal/api-client";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/link тянет роутер Next — в компонентных тестах он не нужен.
vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: React.ComponentProps<"a"> & { prefetch?: boolean }) => {
    // prefetch — проп next/link, в DOM-атрибут <a> его отдавать нельзя.
    void prefetch;
    return (
      <a href={typeof href === "string" ? href : "#"} {...rest}>
        {children}
      </a>
    );
  },
}));

// Состояние авторизации мутируем между тестами: так один компонент можно
// проверить и как гостя, и как залогиненного с прогрессом.
const auth = vi.hoisted(() => ({
  state: {
    api: null as unknown,
    isAuthed: false,
    user: null as unknown,
    ready: true,
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => auth.state,
  useOptionalAuth: () => auth.state,
}));

import { ItemDetailView } from "@/components/item-detail";

afterEach(cleanup);

const itemDetail: ItemDetail = {
  id: 1,
  type: "serial",
  subtype: null,
  title: "Сталкер",
  originalTitle: "Stalker",
  year: 1979,
  plot: "Проводник ведёт учёного и писателя в Зону.",
  cast: ["Александр Кайдановский"],
  director: ["Андрей Тарковский"],
  duration: { average: 3000, total: 6200 },
  langs: 2,
  ac3: true,
  quality: 1080,
  genres: [{ id: 1, title: "фантастика" }],
  countries: [{ id: 1, title: "СССР" }],
  imdb: { id: 80000, rating: 8.1, votes: 1000 },
  kinopoisk: { id: null, rating: 7.9, votes: null },
  tmdb: { id: 123, rating: null, votes: 500 },
  rating: 8.1,
  votes: { positive: 10, negative: 1, total: 11 },
  views: 100,
  finished: true,
  advert: false,
  posters: { small: null, medium: null, big: null },
  trailer: { id: null, url: null },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  seasons: [
    {
      id: 10,
      number: 1,
      title: null,
      episodes: [
        { id: 100, number: 1, title: "Пилот", thumbnailUrl: null, runtime: 3000, mediaId: 500 },
        { id: 101, number: 2, title: null, thumbnailUrl: null, runtime: 3100, mediaId: 501 },
      ],
    },
    {
      id: 11,
      number: 2,
      title: null,
      episodes: [
        { id: 200, number: 1, title: "Возвращение", thumbnailUrl: null, runtime: 3200, mediaId: 600 },
      ],
    },
  ],
  media: null,
};

const emptyProgress: ItemProgressDto = {
  itemId: 1,
  entries: [],
  resumeMediaId: null,
  resumePositionSeconds: 0,
};

function makeApi(progress: ItemProgressDto = emptyProgress) {
  return {
    getItemProgress: vi.fn().mockResolvedValue({ progress }),
    getMediaLinks: vi.fn().mockResolvedValue({}),
    getItemSocial: vi.fn().mockResolvedValue({
      social: {
        vote: { myVote: null, votes: { positive: 0, negative: 0, total: 0 } },
        subscription: null,
        commentsCount: 0,
      },
    }),
    listComments: vi.fn().mockResolvedValue({ items: [], nextOffset: null, total: 0 }),
    getFavorite: vi.fn().mockResolvedValue({ favorite: null }),
  };
}

beforeEach(() => {
  auth.state.api = null;
  auth.state.isAuthed = false;
  auth.state.user = null;
});

describe("ItemDetailView — сезонный пикер и прогресс", () => {
  it("выбирает сезон с последней начатой серией и предлагает продолжить", async () => {
    auth.state.api = makeApi({
      itemId: 1,
      entries: [
        {
          mediaId: 500,
          positionSeconds: 0,
          durationSeconds: 3000,
          progress: 0,
          status: "unwatched",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          mediaId: 600,
          positionSeconds: 900,
          durationSeconds: 3200,
          progress: 0.28,
          status: "in_progress",
          updatedAt: "2026-02-01T00:00:00Z",
        },
      ],
      resumeMediaId: 600,
      resumePositionSeconds: 900,
    });
    auth.state.isAuthed = true;
    auth.state.user = { id: 1 };

    render(<ItemDetailView item={itemDetail} />);

    // Активный сезон — второй (там resume), а не первый по умолчанию.
    await waitFor(() => {
      const tabs = screen.getAllByTestId("season-tab");
      expect(tabs[1]!.className).toContain("bg-accent");
    });

    const watch = screen.getByTestId("watch-button");
    expect(watch.getAttribute("href")).toBe("/watch/1/600");
    expect(watch.textContent).toContain("Продолжить S2E1");

    // Вторичное управление «Сначала» ведёт к самому началу тайтла.
    expect(screen.getByTestId("watch-from-start").getAttribute("href")).toBe("/watch/1/500");

    // Начатая серия показывает полосу прогресса.
    expect(screen.getByTestId("episode-progress")).toBeDefined();
  });

  it("помечает просмотренные серии галочкой", async () => {
    auth.state.api = makeApi({
      itemId: 1,
      entries: [
        {
          mediaId: 500,
          positionSeconds: 3000,
          durationSeconds: 3000,
          progress: 1,
          status: "watched",
          updatedAt: "2026-01-05T00:00:00Z",
        },
      ],
      resumeMediaId: null,
      resumePositionSeconds: 0,
    });
    auth.state.isAuthed = true;
    auth.state.user = { id: 1 };

    render(<ItemDetailView item={itemDetail} />);

    await waitFor(() => {
      expect(screen.getByTestId("episode-watched")).toBeDefined();
    });
  });

  it("гость не запрашивает прогресс и видит обычное «Смотреть»", async () => {
    const api = makeApi();
    auth.state.api = api;
    auth.state.isAuthed = false;

    render(<ItemDetailView item={itemDetail} />);

    const watch = screen.getByTestId("watch-button");
    expect(watch.textContent).toContain("Смотреть");
    expect(watch.getAttribute("href")).toBe("/watch/1/500");
    expect(screen.queryByTestId("watch-from-start")).toBeNull();
    expect(api.getItemProgress).not.toHaveBeenCalled();
  });
});

describe("ItemDetailView — трейлер", () => {
  it("честно называет поиск, когда трейлера нет", () => {
    render(<ItemDetailView item={itemDetail} />);
    const button = screen.getByTestId("trailer-button");
    expect(button.textContent).toContain("Найти трейлер");

    fireEvent.click(button);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Поиск трейлера");
    expect(dialog.textContent).toContain("поиск на YouTube");
    expect((screen.getByTitle("Трейлер Сталкер") as HTMLIFrameElement).src).toContain(
      "listType=search",
    );
  });

  it("встраивает реальный трейлер, если он есть", () => {
    render(
      <ItemDetailView
        item={{ ...itemDetail, trailer: { id: null, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }}
      />,
    );
    const button = screen.getByTestId("trailer-button");
    expect(button.textContent).toContain("Трейлер");

    fireEvent.click(button);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Трейлер: Сталкер");
    expect(dialog.textContent).not.toContain("поиск на YouTube");
    expect((screen.getByTitle("Трейлер Сталкер") as HTMLIFrameElement).src).toContain(
      "embed/dQw4w9WgXcQ",
    );
  });
});
