import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BufferingOverlay,
  NextEpisodeOverlay,
  PlaybackError,
  SkipIntroButton,
  SubtitleOverlay,
  UnmuteOverlay,
} from "@/components/player/overlays";

afterEach(cleanup);

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  // jsdom не даёт navigator.clipboard, а кнопка «Скопировать поток» без него
  // падает — проверять тогда было бы нечего.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  writeText.mockClear();
});

describe("субтитры", () => {
  it("рисует активные реплики", () => {
    render(<SubtitleOverlay cues={[{ start: 1, end: 3, text: "Привет" }]} />);
    expect(screen.getByTestId("subtitle-overlay").textContent).toBe("Привет");
  });

  it("без активных реплик оверлея нет вовсе", () => {
    // Пустой прямоугольник с testid ловился бы e2e-проверкой как «субтитры
    // показаны» — а их нет.
    render(<SubtitleOverlay cues={[]} />);
    expect(screen.queryByTestId("subtitle-overlay")).toBeNull();
  });
});

describe("пропуск интро", () => {
  it("клик перематывает на конец отрезка", () => {
    const onSkip = vi.fn();
    render(<SkipIntroButton endSeconds={87} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId("skip-intro"));
    expect(onSkip).toHaveBeenCalledWith(87);
  });
});

describe("звук заблокирован политикой автоплея", () => {
  it("клик снимает заглушку", () => {
    const onUnmute = vi.fn();
    render(<UnmuteOverlay onUnmute={onUnmute} />);
    fireEvent.click(screen.getByTestId("unmute-overlay"));
    expect(onUnmute).toHaveBeenCalledTimes(1);
  });
});

describe("следующая серия", () => {
  it("подпись и переход берутся из одной серии", () => {
    const onPlay = vi.fn();
    render(
      <NextEpisodeOverlay next={{ mediaId: 202, label: "S2E5", title: null }} onPlay={onPlay} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "S2E5" }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});

describe("индикатор буферизации", () => {
  it("на переборе раздач показывает, которую пробует", () => {
    render(<BufferingOverlay switchingSource deadCount={2} totalFiles={8} />);
    expect(screen.getByTestId("player-buffering").textContent).toBe(
      "Раздача не заиграла — пробуем следующую (3 из 8)…",
    );
  });

  it("без перебора — обычная буферизация", () => {
    render(<BufferingOverlay switchingSource={false} deadCount={0} totalFiles={8} />);
    expect(screen.getByTestId("player-buffering").textContent).toContain("Буферизация потока");
  });
});

describe("экран ошибки", () => {
  it("показывает текст ошибки и повтор", () => {
    const onRetry = vi.fn();
    render(<PlaybackError error="Ни одна раздача не заиграла" streamUrl="" onRetry={onRetry} />);
    expect(screen.getByText("Ни одна раздача не заиграла")).toBeTruthy();
    fireEvent.click(screen.getByTestId("player-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("без адреса потока внешних плееров и копирования нет", () => {
    render(<PlaybackError error="x" streamUrl="" onRetry={() => {}} />);
    expect(screen.queryByText("Открыть в VLC")).toBeNull();
    expect(screen.queryByText("Скопировать поток")).toBeNull();
  });

  it("ссылки внешних плееров абсолютные", () => {
    render(<PlaybackError error="x" streamUrl="https://zal.example/gst/m.m3u8" onRetry={() => {}} />);
    expect(screen.getByText("Открыть в VLC").closest("a")?.getAttribute("href")).toBe(
      "vlc://https://zal.example/gst/m.m3u8",
    );
    expect(screen.getByText("Открыть в IINA (Mac)").closest("a")?.getAttribute("href")).toBe(
      `iina://weblink?url=${encodeURIComponent("https://zal.example/gst/m.m3u8")}`,
    );
  });

  it("подпись копирования возвращается через 2 с", () => {
    vi.useFakeTimers();
    try {
      render(<PlaybackError error="x" streamUrl="https://zal.example/gst/m.m3u8" onRetry={() => {}} />);
      fireEvent.click(screen.getByText("Скопировать поток"));
      expect(writeText).toHaveBeenCalledWith("https://zal.example/gst/m.m3u8");
      expect(screen.getByText("Ссылка скопирована")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText("Скопировать поток")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("повторный клик отсчитывает две секунды заново", () => {
    // Раньше здесь был setTimeout без clearTimeout: таймер первого клика гасил
    // подпись через 2с после НЕГО, даже если пользователь нажал ещё раз.
    vi.useFakeTimers();
    try {
      render(<PlaybackError error="x" streamUrl="https://zal.example/gst/m.m3u8" onRetry={() => {}} />);
      fireEvent.click(screen.getByText("Скопировать поток"));
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      fireEvent.click(screen.getByText("Ссылка скопирована"));
      act(() => {
        // 3000 мс от первого клика, но лишь 1500 от второго.
        vi.advanceTimersByTime(1500);
      });
      expect(screen.getByText("Ссылка скопирована")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByText("Скопировать поток")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
