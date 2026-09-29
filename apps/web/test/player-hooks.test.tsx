import { act, cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import type { MediaLinks } from "@zal/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayerHotkeys, useScrubPreview, useSubtitleTracks } from "@/components/player/hooks";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ---------- Клавиатура ---------- */

function hotkeys(over: Partial<Parameters<typeof usePlayerHotkeys>[0]> = {}) {
  // Моки отдельным объектом: если положить `vi.fn()` в объект с типом
  // `Partial<Handlers>`, TypeScript теряет тип мока и `.mock` на нём нет.
  const mocks = {
    onTogglePlay: vi.fn(),
    seekBy: vi.fn(),
    onVolume: vi.fn(),
    onSubtitle: vi.fn(),
    onFullscreen: vi.fn(),
    onPip: vi.fn(),
    onShift: vi.fn(),
  };
  renderHook(() =>
    usePlayerHotkeys({
      ...mocks,
      volume: 0.5,
      muted: false,
      subtitlesOn: false,
      ...over,
    }),
  );
  const press = (key: string) => act(() => void fireEvent.keyDown(window, { key }));
  return { mocks, press };
}

describe("хоткеи плеера", () => {
  it("пробел и k переключают воспроизведение", () => {
    const { mocks, press } = hotkeys();
    press(" ");
    press("k");
    expect(mocks.onTogglePlay).toHaveBeenCalledTimes(2);
  });

  it("пробел гасит прокрутку страницы, а j и l — нет", () => {
    // Пробел и стрелки браузер обрабатывает сам; остальные буквы ничьи, и
    // гасить их preventDefault'ом значило бы ломать чужие шорткаты.
    hotkeys();
    const space = new KeyboardEvent("keydown", { key: " ", cancelable: true });
    act(() => void window.dispatchEvent(space));
    expect(space.defaultPrevented).toBe(true);

    const j = new KeyboardEvent("keydown", { key: "j", cancelable: true });
    act(() => void window.dispatchEvent(j));
    expect(j.defaultPrevented).toBe(false);
  });

  it("стрелки перематывают на 5 секунд, j и l — на 10", () => {
    const { mocks, press } = hotkeys();
    press("ArrowRight");
    press("ArrowLeft");
    press("l");
    press("j");
    expect(mocks.seekBy.mock.calls.map((c) => c[0])).toEqual([5, -5, 10, -10]);
  });

  it("буквы не работают, пока курсор в поле ввода", () => {
    const { mocks, press } = hotkeys();
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => void fireEvent.keyDown(input, { key: "k" }));
    expect(mocks.onTogglePlay).not.toHaveBeenCalled();

    // Из поля фокус ушёл — клавиша снова наша.
    press("k");
    expect(mocks.onTogglePlay).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("громкость зажата в [0,1]", () => {
    const loud = hotkeys({ volume: 1 });
    loud.press("ArrowUp");
    expect(loud.mocks.onVolume).toHaveBeenCalledWith(1);

    const quiet = hotkeys({ volume: 0 });
    quiet.press("ArrowDown");
    expect(quiet.mocks.onVolume).toHaveBeenCalledWith(0);
  });

  it("m помнит прежнюю громкость, а не возвращает единицу", () => {
    const on = hotkeys({ muted: true, volume: 0.4 });
    on.press("m");
    expect(on.mocks.onVolume).toHaveBeenCalledWith(0.4);

    const off = hotkeys({ muted: false, volume: 0.4 });
    off.press("m");
    expect(off.mocks.onVolume).toHaveBeenCalledWith(0);
  });

  it("c включает первую дорожку и выключает текущую", () => {
    const off = hotkeys({ subtitlesOn: false });
    off.press("c");
    expect(off.mocks.onSubtitle).toHaveBeenCalledWith(0);

    const on = hotkeys({ subtitlesOn: true });
    on.press("c");
    expect(on.mocks.onSubtitle).toHaveBeenCalledWith(null);
  });

  it("скобки двигают сдвиг субтитров на 100 мс", () => {
    const { mocks, press } = hotkeys();
    press("[");
    press("]");
    expect(mocks.onShift.mock.calls.map((c) => c[0])).toEqual([-100, 100]);
  });
});

/* ---------- Дорожки субтитров ---------- */

const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nПривет\n";

type Subs = MediaLinks["subtitles"];

function sub(over: Partial<Subs[number]> = {}): Subs[number] {
  return { id: 1, lang: "ru", shiftMs: 0, embed: false, title: null, url: "/sub/1.vtt", ...over };
}

describe("дорожки субтитров", () => {
  it("подпись — заголовок, а без него код языка", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => VTT })),
    );
    const { result } = renderHook(() =>
      useSubtitleTracks([sub({ title: "Русские" }), sub({ id: 2, lang: "en", url: "/sub/2.vtt" })]),
    );
    await waitFor(() => expect(result.current[0][0]?.cues.length).toBeGreaterThan(0));
    expect(result.current[0].map((t) => t.label)).toEqual(["Русские", "EN"]);
  });

  it("индекс дорожки совпадает с её местом в списке", async () => {
    // По индексу потом ищут дорожку при выборе — сдвиг на единицу увёл бы
    // пользователя на соседнюю.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => VTT })),
    );
    const { result } = renderHook(() =>
      useSubtitleTracks([sub(), sub({ id: 2, url: "/sub/2.vtt" }), sub({ id: 3, url: null })]),
    );
    await waitFor(() => expect(result.current[0][1]?.cues.length).toBeGreaterThan(0));
    expect(result.current[0].map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it("реплики доезжают из VTT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => VTT })),
    );
    const { result } = renderHook(() => useSubtitleTracks([sub()]));
    await waitFor(() => expect(result.current[0][0]?.cues.length).toBe(1));
    expect(result.current[0][0]?.cues[0]?.text).toBe("Привет");
  });

  it("упавшая дорожка остаётся в списке, но без реплик", async () => {
    // Пропажа пункта из меню читается как сбой плеера; пустой текст — нет.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, text: async () => "" })),
    );
    const { result } = renderHook(() => useSubtitleTracks([sub()]));
    await waitFor(() => expect(result.current[0].length).toBe(1));
    expect(result.current[0][0]?.cues).toEqual([]);
    expect(result.current[0][0]?.label).toBe("RU");
  });

  it("дорожка без адреса не ходит в сеть", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => VTT }));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useSubtitleTracks([sub({ url: null })]));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("дорожки без адресов всё равно попадают в список", async () => {
    // Встроенные в манифест субтитры gst приходят с url: null, и до подмены
    // списка из инициализации потока они должны быть видны.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => VTT })),
    );
    const { result } = renderHook(() => useSubtitleTracks([sub({ url: null })]));
    await waitFor(() => expect(result.current[0].length).toBe(1));
    expect(result.current[0][0]?.url).toBeNull();
  });
});

/* ---------- Превью при перемотке ---------- */

describe("превью при перемотке", () => {
  const file = (http: string, hls: string | null) => ({ urls: { http, hls } });
  const sprite = {
    url: "/s.jpg",
    intervalSeconds: 10,
    tileWidth: 160,
    tileHeight: 90,
    columns: 5,
    rows: 5,
    count: 25,
  };

  it("со спрайтом второго видео нет", () => {
    const { result } = renderHook(() => useScrubPreview(sprite, file("/stream?f=1", null)));
    expect(result.current.previewSrc).toBeNull();
  });

  it("у hls-раздачи превью нет — прямого адреса не существует", () => {
    const { result } = renderHook(() =>
      useScrubPreview(null, file("/stream?f=1", "/gst/master.m3u8")),
    );
    expect(result.current.previewSrc).toBeNull();
  });

  it("без спрайта и без hls берётся прямой адрес", () => {
    const { result } = renderHook(() => useScrubPreview(null, file("/stream?f=1", null)));
    expect(result.current.previewSrc).toBe("/stream?f=1");
  });

  it("раздачи нет — превью нет", () => {
    const { result } = renderHook(() => useScrubPreview(null, undefined));
    expect(result.current.previewSrc).toBeNull();
  });

  it("сик ставится, но мелкие сдвиги не дёргают торрсервер", () => {
    const { result } = renderHook(() => useScrubPreview(null, file("/stream?f=1", null)));
    const pv = { currentTime: 0 } as HTMLVideoElement;
    result.current.previewRef.current = pv;

    act(() => result.current.onScrubTime(30));
    expect(pv.currentTime).toBe(30);

    act(() => result.current.onScrubTime(30.5));
    expect(pv.currentTime).toBe(30);

    act(() => result.current.onScrubTime(31));
    expect(pv.currentTime).toBe(31);
  });

  it("ноль и мусор игнорируются", () => {
    const { result } = renderHook(() => useScrubPreview(null, file("/stream?f=1", null)));
    const pv = { currentTime: 12 } as HTMLVideoElement;
    result.current.previewRef.current = pv;

    act(() => result.current.onScrubTime(0));
    act(() => result.current.onScrubTime(Number.NaN));
    act(() => result.current.onScrubTime(null));
    expect(pv.currentTime).toBe(12);
  });

  it("без элемента не падает", () => {
    const { result } = renderHook(() => useScrubPreview(null, file("/stream?f=1", null)));
    expect(() => act(() => result.current.onScrubTime(30))).not.toThrow();
  });
});
