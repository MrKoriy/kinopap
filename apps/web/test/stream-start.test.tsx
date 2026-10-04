/**
 * Старт видео в вебе: этапы загрузки, кнопка «Не играет / не та серия»
 * и префетч с карточки (дебаунс, дедуп, лимит).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reportStream: vi.fn(),
  prefetchItem: vi.fn(),
}));

vi.mock("@/lib/auth", () => {
  const state = {
    api: { reportStream: mocks.reportStream, prefetchItem: mocks.prefetchItem },
    isAuthed: false,
    ready: true,
  };
  return { useAuth: () => state, useOptionalAuth: () => state };
});

import { ApiError } from "@zal/api-client";
import { LoadingStages } from "@/components/player/loading-stages";
import { StreamReportButton } from "@/components/player/report-button";
import { createPrefetchGate, PREFETCH_DEBOUNCE_MS, useStreamPrefetch } from "@/lib/stream-prefetch";

const HASH = "e".repeat(40);

afterEach(cleanup);
beforeEach(() => {
  mocks.reportStream.mockReset();
  mocks.prefetchItem.mockReset();
  mocks.prefetchItem.mockResolvedValue({ ready: false, queued: true });
});

describe("LoadingStages", () => {
  it("пройденные этапы отмечены, текущий активен, следующие ждут", () => {
    render(<LoadingStages stage="connect" hint="Связываемся с раздачей" />);
    expect(screen.getByTestId("stage-search").dataset.state).toBe("done");
    expect(screen.getByTestId("stage-connect").dataset.state).toBe("active");
    expect(screen.getByTestId("stage-buffer").dataset.state).toBe("pending");
    expect(screen.getByTestId("player-stages").textContent).toContain("Связываемся с раздачей");
  });

  it("порядок этапов: ищем источник → подключаемся → буферизуем", () => {
    render(<LoadingStages stage="buffer" />);
    expect(screen.getByTestId("player-stages").textContent).toMatch(
      /Ищем источник.*Подключаемся.*Буферизуем/,
    );
  });
});

describe("StreamReportButton", () => {
  it("серия: «Не та серия» уходит с хешем раздачи и перезапрашивает ссылки", async () => {
    mocks.reportStream.mockResolvedValue({ ok: true, banned: true });
    const onReported = vi.fn();
    render(
      <StreamReportButton
        mediaId={7}
        streamUrl={`/gst-s/1/sig/${HASH}/master.m3u8?index=2`}
        isEpisode
        onReported={onReported}
      />,
    );
    fireEvent.click(screen.getByTestId("stream-report-toggle"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("stream-report-wrong-episode"));
    });
    expect(mocks.reportStream).toHaveBeenCalledWith(7, { reason: "wrong_episode", hash: HASH });
    expect(onReported).toHaveBeenCalledTimes(1);
  });

  it("фильм: без пункта «Не та серия»; 429 — понятное сообщение", async () => {
    mocks.reportStream.mockRejectedValue(
      new ApiError(429, { error: { code: "rate_limited", message: "Rate limit exceeded" } }),
    );
    const onReported = vi.fn();
    render(
      <StreamReportButton
        mediaId={3}
        streamUrl={`/stream?link=${HASH}&index=1&play`}
        isEpisode={false}
        onReported={onReported}
      />,
    );
    fireEvent.click(screen.getByTestId("stream-report-toggle"));
    expect(screen.queryByTestId("stream-report-wrong-episode")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("stream-report-not-playing"));
    });
    expect(onReported).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("через минуту");
  });

  it("не торрент (HLS AniLibria) — кнопки нет", () => {
    render(
      <StreamReportButton mediaId={1} streamUrl="https://cdn.libria/ep1/index.m3u8" isEpisode />,
    );
    expect(screen.queryByTestId("stream-report")).toBeNull();
  });
});

describe("prefetch gate", () => {
  it("один запрос на тайтл за TTL и не больше N в минуту", () => {
    const gate = createPrefetchGate({ ttlMs: 1000, perMinute: 2 });
    expect(gate.allow(1, 0)).toBe(true);
    expect(gate.allow(1, 10)).toBe(false);
    expect(gate.allow(2, 20)).toBe(true);
    expect(gate.allow(3, 30)).toBe(false);
    // Новая минута — окно сброшено; TTL первого тайтла истёк.
    expect(gate.allow(1, 61_000)).toBe(true);
  });
});

function Probe({ id }: { id: number }) {
  const p = useStreamPrefetch(id);
  return (
    <button type="button" data-testid="probe" onMouseEnter={p.intent} onMouseLeave={p.cancel}>
      x
    </button>
  );
}

describe("useStreamPrefetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("пролёт мышью без задержки — ни одного запроса", () => {
    render(<Probe id={101} />);
    fireEvent.mouseEnter(screen.getByTestId("probe"));
    act(() => vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS - 50));
    fireEvent.mouseLeave(screen.getByTestId("probe"));
    act(() => vi.advanceTimersByTime(1000));
    expect(mocks.prefetchItem).not.toHaveBeenCalled();
  });

  it("задержался над карточкой — один запрос, повторное наведение не шлёт", () => {
    render(<Probe id={102} />);
    const el = screen.getByTestId("probe");
    fireEvent.mouseEnter(el);
    act(() => vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS + 10));
    fireEvent.mouseLeave(el);
    fireEvent.mouseEnter(el);
    act(() => vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS + 10));
    expect(mocks.prefetchItem).toHaveBeenCalledTimes(1);
    expect(mocks.prefetchItem).toHaveBeenCalledWith(102);
  });
});
