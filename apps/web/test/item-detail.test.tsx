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

describe("ItemDetailView — подпись главной кнопки у фильма", () => {
  /** Фильм из `parts` частей: сезонов у него нет, контент лежит в `media`. */
  const movie = (parts: number): ItemDetail => ({
    ...itemDetail,
    type: "movie",
    seasons: null,
    media: Array.from({ length: parts }, (_, i) => ({
      id: 700 + i,
      partNumber: i + 1,
      title: null,
      thumbnailUrl: null,
      runtime: 3000,
    })),
  });

  const resumeAt = (mediaId: number): ItemProgressDto => ({
    itemId: 1,
    entries: [],
    resumeMediaId: mediaId,
    resumePositionSeconds: 900,
  });

  // Раньше веб искал слот только среди серий, поэтому на многочастевом фильме
  // писал просто «Продолжить» — мобильный в том же состоянии писал «Часть 2».
  // Правило переехало в @zal/shared, и этот тест сторожит, что оно там одно.
  it("многочастевый фильм называет часть, на которой остановились", async () => {
    auth.state.api = makeApi(resumeAt(701));
    auth.state.isAuthed = true;
    auth.state.user = { id: 1 };

    render(<ItemDetailView item={movie(2)} />);

    await waitFor(() => {
      expect(screen.getByTestId("watch-button").textContent).toContain("Продолжить Часть 2");
    });
    expect(screen.getByTestId("watch-button").getAttribute("href")).toBe("/watch/1/701");
  });

  // Единственная часть — это не часть, а сам фильм. Позицию восстанавливает
  // плеер, поэтому «Смотреть» честнее, чем «Продолжить Часть 1».
  it("одночастевый фильм с точкой возобновления — «Смотреть»", async () => {
    auth.state.api = makeApi(resumeAt(700));
    auth.state.isAuthed = true;
    auth.state.user = { id: 1 };

    render(<ItemDetailView item={movie(1)} />);

    await waitFor(() => {
      expect(screen.getByTestId("watch-button").textContent).toContain("Смотреть");
    });
    expect(screen.getByTestId("watch-button").textContent).not.toContain("Часть");
    expect(screen.getByTestId("watch-button").getAttribute("href")).toBe("/watch/1/700");
  });
});


describe("ItemDetailView — спецвыпуски, актёры, франшиза", () => {
  const rich: ItemDetail = {
    ...itemDetail,
    specials: {
      id: 99,
      number: 0,
      title: null,
      episodes: [{ id: 900, number: 1, title: "Новогодний выпуск", thumbnailUrl: null, runtime: 0, mediaId: 990 }],
    },
    credits: {
      cast: [{ id: 1, name: "Александр Кайдановский", photoUrl: null, role: "actor", character: "Сталкер" }],
      crew: [{ id: 2, name: "Андрей Тарковский", photoUrl: null, role: "director", character: null }],
    },
    franchise: {
      id: 5,
      title: "Сталкер",
      entries: [
        { anilistId: 1, title: "Сталкер", format: "TV", year: 1979, episodes: 3, itemId: 1 },
        { anilistId: 2, title: "Сталкер: Фильм", format: "MOVIE", year: 1980, episodes: 1, itemId: 7 },
      ],
    },
  };

  it("вкладка «Спецвыпуски» последней, не первой", async () => {
    render(<ItemDetailView item={rich} />);
    const specials = screen.getByTestId("specials-tab");
    expect(specials.textContent).toContain("Спецвыпуски");
    expect(screen.getAllByTestId("season-tab")).toHaveLength(2);
    // «Смотреть» по-прежнему ведёт на S01E01, а не на спешл.
    expect(screen.getByTestId("watch-button").getAttribute("href")).toBe("/watch/1/500");
    specials.click();
    await waitFor(() => expect(screen.getByText("Новогодний выпуск")).toBeDefined());
  });

  it("блоки «Актёры и команда» и «Франшиза»", () => {
    render(<ItemDetailView item={rich} />);
    const credits = screen.getByTestId("credits");
    expect(credits.textContent).toContain("Сталкер");
    expect(credits.textContent).toContain("Режиссёр");
    const entries = screen.getAllByTestId("franchise-entry");
    expect(entries).toHaveLength(2);
    // текущий тайтл — без ссылки, соседний — ссылка на карточку
    expect(entries[0]!.querySelector("a")).toBeNull();
    expect(entries[1]!.querySelector("a")?.getAttribute("href")).toBe("/item/7");
  });
});

describe("ItemDetailView — длинный сезон", () => {
  const long: ItemDetail = {
    ...itemDetail,
    seasons: [
      {
        id: 10,
        number: 1,
        title: "Серии 1–130",
        episodes: Array.from({ length: 130 }, (_, i) => ({
          id: 1000 + i,
          number: i + 1,
          title: `Серия ${i + 1}`,
          thumbnailUrl: null,
          runtime: 1400,
          mediaId: 5000 + i,
        })),
      },
    ],
  };

  it("«Серия №» открывает нужный диапазон и подсвечивает серию", async () => {
    render(<ItemDetailView item={long} />);
    expect(screen.getByTestId("episode-ranges")).toBeDefined();
    expect(screen.queryByText("Серия 120")).toBeNull();
    const form = screen.getByTestId("episode-jump");
    fireEvent.change(form.querySelector("input")!, { target: { value: "120" } });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText("Серия 120")).toBeDefined());
    expect(document.getElementById("ep-1119")?.className).toContain("ring-accent");

    fireEvent.change(form.querySelector("input")!, { target: { value: "999" } });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText("Нет такой серии")).toBeDefined());
  });
});
