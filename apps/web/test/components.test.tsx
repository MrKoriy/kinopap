import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ItemDetail, ItemSummary, SpriteMetaDto } from "@zal/api-client";
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
    // prefetch — проп next/link, в DOM-атрибут <a> его отдавать нельзя.
    void prefetch;
    return (
      <a href={typeof href === "string" ? href : "#"} {...rest}>
        {children}
      </a>
    );
  },
}));

// ItemDetailView дергает useAuth для тихого прогрева стримов, Comments —
// useOptionalAuth для формы комментария.
vi.mock("@/lib/auth", () => {
  const state = {
    api: null,
    isAuthed: false,
    user: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    ready: true,
  };
  return { useAuth: () => state, useOptionalAuth: () => state };
});

import { ItemCard } from "@/components/item-card";
import { ItemDetailView } from "@/components/item-detail";
import { PlayerControls, PlayerTimeContext } from "@/components/player/controls";

afterEach(cleanup);

const sprites: SpriteMetaDto = {
  url: "http://cdn/sprite.jpg",
  intervalSeconds: 5,
  tileWidth: 160,
  tileHeight: 90,
  columns: 3,
  rows: 2,
  count: 6,
};

/**
 * jsdom не считает раскладку: getBoundingClientRect у него всегда нулевой, и
 * доля по clientX вышла бы NaN. Подменяем полосе прямоугольник 0..100 —
 * тогда clientX читается прямо как процент.
 */
function withRect(el: HTMLElement): HTMLElement {
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      width: 100,
      top: 0,
      height: 2,
      right: 100,
      bottom: 2,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

function makeControls(
  overrides: Partial<React.ComponentProps<typeof PlayerControls>> = {},
  /** Позиция воспроизведения — въезжает контекстом, не пропом. */
  currentTime = 30,
) {
  const props: React.ComponentProps<typeof PlayerControls> = {
    playing: false,
    duration: 120,
    volume: 1,
    muted: false,
    playbackRate: 1,
    speeds: [1, 1.5, 2],
    shiftMs: 0,
    audioTracks: [
      { index: 0, label: "MVO · Кинопоиск (ru)" },
      { index: 1, label: "AVO (en)" },
    ],
    activeAudio: 0,
    subtitles: [
      { index: 0, label: "Русские" },
      { index: 1, label: "Английские" },
    ],
    activeSubtitle: null,
    sprites,
    spriteUrl: sprites.url,
    isFullscreen: false,
    onTogglePlay: vi.fn(),
    onSeek: vi.fn(),
    onVolume: vi.fn(),
    onRate: vi.fn(),
    onAudio: vi.fn(),
    onSubtitle: vi.fn(),
    onShift: vi.fn(),
    onPip: vi.fn(),
    onFullscreen: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(
      <PlayerTimeContext.Provider value={currentTime}>
        <PlayerControls {...props} />
      </PlayerTimeContext.Provider>,
    ),
  };
}

describe("PlayerControls", () => {
  it("показывает время и переключает play/паузу", () => {
    const { props } = makeControls();
    expect(screen.getByText(/0:30 \/ 2:00/)).toBeDefined();
    fireEvent.click(screen.getByTestId("play-toggle"));
    expect(props.onTogglePlay).toHaveBeenCalledOnce();
  });

  it("кликом по seek-бару зовёт onSeek с временем", () => {
    const { props } = makeControls();
    const bar = withRect(screen.getByTestId("seekbar"));
    // Клик — это pointerdown + pointerup. Отдельного onClick у полосы нет
    // намеренно: он сработал бы вторым и перемотал дважды.
    // Точка выбрана заведомо далеко от currentTime (30 с) — иначе сработал бы
    // порог SEEK_EPSILON_SECONDS, и тест проверял бы не клик, а порог.
    fireEvent.pointerDown(bar, { clientX: 75, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 75, pointerId: 1 });
    expect(props.onSeek).toHaveBeenCalledWith(90); // 75% от 120с
  });

  it("перемотка не выполняется, если отпустили почти на месте", () => {
    // currentTime = 30 с, отпускаем в 31.5 с. На торрент-стриме такая перемотка
    // рвёт загрузку и поднимает gst заново — цена есть, результата нет.
    const { props } = makeControls();
    const bar = withRect(screen.getByTestId("seekbar"));
    fireEvent.pointerDown(bar, { clientX: 26.25, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 26.25, pointerId: 1 });
    expect(props.onSeek).not.toHaveBeenCalled();
  });

  it("во время перетаскивания не мотает, а на отпускании — мотает один раз", () => {
    // Перемотка на каждом pointermove пересобирала бы конвейер десятки раз за
    // жест: перетаскивание стало бы неюзабельным.
    const { props } = makeControls();
    const bar = withRect(screen.getByTestId("seekbar"));
    fireEvent.pointerDown(bar, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 70, pointerId: 1 });
    expect(props.onSeek).not.toHaveBeenCalled();
    fireEvent.pointerUp(bar, { clientX: 70, pointerId: 1 });
    expect(props.onSeek).toHaveBeenCalledOnce();
    expect(props.onSeek).toHaveBeenCalledWith(84); // 70% от 120с
  });

  it("отменённый жест не мотает", () => {
    const { props } = makeControls();
    const bar = withRect(screen.getByTestId("seekbar"));
    fireEvent.pointerDown(bar, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 80, pointerId: 1 });
    fireEvent.pointerCancel(bar, { clientX: 80, pointerId: 1 });
    expect(props.onSeek).not.toHaveBeenCalled();
  });

  it("во время перетаскивания полоса идёт за указателем, а не за видео", () => {
    // Без этого перетаскивание слепое: пользователь ведёт палец, а полоса
    // стоит на месте, потому что видео ещё не перемотано.
    makeControls({ duration: 120 });
    const bar = withRect(screen.getByTestId("seekbar"));
    expect(screen.getByTestId("seek-progress").style.width).toBe("25%"); // 30/120

    fireEvent.pointerDown(bar, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 90, pointerId: 1 });
    expect(screen.getByTestId("seek-progress").style.width).toBe("90%");
  });

  it("после отпускания полоса возвращается к времени видео", () => {
    makeControls({ duration: 120 });
    const bar = withRect(screen.getByTestId("seekbar"));
    fireEvent.pointerDown(bar, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 90, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 90, pointerId: 1 });
    // onSeek в тесте — заглушка, время видео не меняется. Полоса обязана
    // вернуться к currentTime, а не залипнуть на месте отпускания.
    expect(screen.getByTestId("seek-progress").style.width).toBe("25%");
  });

  it("рисует серые отрезки буфера по долям длительности", () => {
    makeControls({
      buffered: [
        { start: 0.25, end: 0.5 },
        { start: 0.75, end: 1 },
      ],
    });
    const segs = screen.getAllByTestId("buffer-segment");
    expect(segs).toHaveLength(2);
    expect(segs[0]!.style.left).toBe("25%");
    expect(segs[0]!.style.width).toBe("25%");
    expect(segs[1]!.style.left).toBe("75%");
    expect(segs[1]!.style.width).toBe("25%");
  });

  it("буфер не перехватывает нажатие по полосе", () => {
    // Сегменты лежат поверх трека. Без pointer-events-none они бы съедали
    // нажатие, и перемотка не работала бы ровно там, где буфер есть.
    makeControls({ buffered: [{ start: 0, end: 1 }] });
    expect(screen.getByTestId("buffer-segment").className).toContain("pointer-events-none");
  });

  it("без буфера сегментов нет", () => {
    makeControls();
    expect(screen.queryAllByTestId("buffer-segment")).toHaveLength(0);
  });

  it("скраб-превью берёт тайл из спрайта", () => {
    makeControls();
    const bar = withRect(screen.getByTestId("seekbar"));
    fireEvent.pointerMove(bar, { clientX: 50, pointerId: 1 });
    const preview = screen.getByTestId("scrub-preview");
    // 50% от 120с = 60с → тайл 5 (зажат по count=6): col=2, row=1.
    // Тайл 160×90 растянут в превью 192×108 (×1.2): позиция и размер
    // сетки обязаны масштабироваться одинаково — иначе превью съезжает.
    const tileDiv = preview.querySelector("div")!;
    expect(tileDiv.style.backgroundImage).toContain("sprite.jpg");
    expect(tileDiv.style.backgroundPosition).toBe("-384px -108px");
    expect(tileDiv.style.backgroundSize).toBe("576px 216px");
  });

  it("меню аудиодорожек переключает дорожку", () => {
    const { props } = makeControls();
    fireEvent.click(screen.getByTestId("menu-аудио"));
    fireEvent.click(screen.getByText("AVO (en)"));
    expect(props.onAudio).toHaveBeenCalledWith(1);
  });

  it("субтитры: выбор и сдвиг ±мс", () => {
    const { props, rerender } = makeControls();
    fireEvent.click(screen.getByTestId("menu-субтитры"));
    fireEvent.click(screen.getByText("Русские"));
    expect(props.onSubtitle).toHaveBeenCalledWith(0);

    // Выбор пункта закрывает меню — открываем снова, чтобы подстроить сдвиг.
    rerender(<PlayerControls {...props} activeSubtitle={0} shiftMs={200} />);
    fireEvent.click(screen.getByTestId("menu-субтитры"));
    expect(screen.getByTestId("shift-value").textContent).toBe("0.2s");
    fireEvent.click(screen.getByTestId("shift-plus"));
    expect(props.onShift).toHaveBeenCalledWith(100);
    fireEvent.click(screen.getByTestId("shift-minus"));
    expect(props.onShift).toHaveBeenCalledWith(-100);
  });

  it("кнопки PiP и полного экрана", () => {
    const { props } = makeControls();
    fireEvent.click(screen.getByTestId("pip"));
    expect(props.onPip).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("fullscreen"));
    expect(props.onFullscreen).toHaveBeenCalledOnce();
  });
});

const itemSummary: ItemSummary = {
  id: 1,
  type: "movie",
  subtype: null,
  title: "Сталкер",
  originalTitle: "Stalker",
  year: 1979,
  plot: "Проводник ведёт учёного и писателя в Зону.",
  cast: ["Александр Кайдановский", "Анатолий Солоницын"],
  director: ["Андрей Тарковский"],
  duration: { average: 6180, total: 6180 },
  langs: 1,
  ac3: false,
  quality: 1080,
  genres: [{ id: 1, title: "фантастика" }],
  countries: [{ id: 1, title: "СССР" }],
  imdb: { id: 80000, rating: 8.1, votes: 1000 },
  kinopoisk: { id: null, rating: null, votes: null },
  tmdb: { id: 123, rating: 8.0, votes: 500 },
  rating: 8.1,
  votes: { positive: 10, negative: 1, total: 11 },
  views: 100,
  finished: null,
  advert: false,
  posters: { small: null, medium: "http://cdn/poster.jpg", big: null },
  trailer: { id: null, url: null },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

const itemDetail: ItemDetail = {
  ...itemSummary,
  type: "serial",
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

describe("ItemCard", () => {
  it("рендерит постер, рейтинг и ссылку на тайтл", () => {
    render(<ItemCard item={itemSummary} />);
    const link = screen.getByTestId("item-card");
    expect(link.getAttribute("href")).toBe("/item/1");
    expect(screen.getByText("8.1")).toBeDefined();
    expect(screen.getByAltText("Сталкер")).toBeDefined();
    expect(screen.getByText("фантастика")).toBeDefined();
  });
});

describe("ItemDetailView", () => {
  it("показывает инфо и кнопку просмотра первого эпизода", () => {
    render(<ItemDetailView item={itemDetail} />);
    expect(screen.getByTestId("item-title").textContent).toBe("Сталкер");
    const watch = screen.getByTestId("watch-button");
    expect(watch.getAttribute("href")).toBe("/watch/1/500");
  });

  it("переключает сезоны и ведёт на эпизод", () => {
    render(<ItemDetailView item={itemDetail} />);
    const tabs = screen.getAllByTestId("season-tab");
    expect(tabs).toHaveLength(2);
    // Сезон 1: две серии.
    expect(screen.getAllByTestId("episode-row")).toHaveLength(2);
    fireEvent.click(tabs[1]!);
    const rows = screen.getAllByTestId("episode-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("href")).toBe("/watch/1/600");
    expect(rows[0]!.textContent).toContain("Возвращение");
  });
});

describe("ItemPoster — свои нарезки и фолбэк", () => {
  it("с images.poster — <picture> AVIF/WebP + плейсхолдер; без — старый путь", async () => {
    const { ItemPoster } = await import("@/components/item-poster");
    const { container, unmount } = render(
      <div className="relative">
        <ItemPoster
          item={{ images: { poster: "/img/ab/abcdef", backdrop: null, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", color: "#112233" } }}
          fallbackSrc="https://image.tmdb.org/t/p/w500/x.jpg"
          alt="Постер"
          sizes="200px"
        />
      </div>,
    );
    const sources = container.querySelectorAll("source");
    expect(sources[0]?.getAttribute("srcset")).toContain("/img/ab/abcdef/160.avif 160w");
    expect(sources[1]?.getAttribute("type")).toBe("image/webp");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/img/ab/abcdef/320.webp");
    expect(container.querySelector("[data-testid=poster-placeholder]")).not.toBeNull();
    unmount();

    const fb = render(<ItemPoster item={{ images: null }} fallbackSrc="https://example.org/x.jpg" alt="П" sizes="200px" />);
    expect(fb.container.querySelector("picture")).toBeNull();
    expect(fb.container.querySelector("img")?.getAttribute("src")).toBe("https://example.org/x.jpg");
  });
});
