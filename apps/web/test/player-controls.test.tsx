import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type EpisodeGroupOption,
  PlayerControls,
  type PlayerControlsProps,
} from "@/components/player/controls";

afterEach(cleanup);

function base(over: Partial<PlayerControlsProps> = {}): PlayerControlsProps {
  return {
    playing: false,
    currentTime: 0,
    duration: 100,
    volume: 1,
    muted: false,
    playbackRate: 1,
    speeds: [1, 2],
    shiftMs: 0,
    audioTracks: [],
    activeAudio: 0,
    subtitles: [],
    activeSubtitle: null,
    sprites: null,
    spriteUrl: null,
    isFullscreen: false,
    onTogglePlay: () => {},
    onSeek: () => {},
    onVolume: () => {},
    onRate: () => {},
    onAudio: () => {},
    onSubtitle: () => {},
    onShift: () => {},
    onPip: () => {},
    onFullscreen: () => {},
    ...over,
  };
}

const TWO_SEASONS: EpisodeGroupOption[] = [
  {
    heading: "Сезон 1",
    episodes: [
      { mediaId: 101, label: "S1E1", title: "Пилот" },
      { mediaId: 102, label: "S1E2", title: null },
    ],
  },
  {
    heading: "Сезон 2",
    episodes: [{ mediaId: 201, label: "S2E1", title: null }],
  },
];

describe("меню выбора серии в плеере", () => {
  it("у фильма меню нет", () => {
    render(<PlayerControls {...base()} />);
    expect(screen.queryByTestId("menu-серии")).toBeNull();
  });

  it("при единственной серии меню тоже нет — выбирать нечего", () => {
    render(
      <PlayerControls
        {...base({
          episodeGroups: [{ heading: "Части", episodes: [{ mediaId: 501, label: "Часть 1", title: null }] }],
          activeEpisode: 501,
        })}
      />,
    );
    expect(screen.queryByTestId("menu-серии")).toBeNull();
  });

  it("показывает список и отдаёт mediaId выбранной серии", () => {
    const onEpisode = vi.fn();
    render(
      <PlayerControls
        {...base({ episodeGroups: TWO_SEASONS, activeEpisode: 101, onEpisode })}
      />,
    );

    fireEvent.click(screen.getByTestId("menu-серии"));
    fireEvent.click(screen.getByTestId("player-episode-102"));

    // Именно mediaId, а не позиция в списке: по нему строится маршрут.
    expect(onEpisode).toHaveBeenCalledWith(102);
  });

  it("открывается на сезоне текущей серии, а не на первом", () => {
    render(
      <PlayerControls
        {...base({ episodeGroups: TWO_SEASONS, activeEpisode: 201, onEpisode: () => {} })}
      />,
    );

    fireEvent.click(screen.getByTestId("menu-серии"));

    expect(screen.getByTestId("player-episode-201")).toBeDefined();
    // Серий первого сезона в списке нет — иначе на седьмом сезоне пришлось бы
    // каждый раз листать до своей серии.
    expect(screen.queryByTestId("player-episode-101")).toBeNull();
  });

  it("сезон переключается табом", () => {
    render(
      <PlayerControls
        {...base({ episodeGroups: TWO_SEASONS, activeEpisode: 201, onEpisode: () => {} })}
      />,
    );

    fireEvent.click(screen.getByTestId("menu-серии"));
    const tabs = screen.getAllByTestId("player-season-tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Сезон 1", "Сезон 2"]);

    fireEvent.click(tabs[0]!);
    expect(screen.getByTestId("player-episode-101")).toBeDefined();
    expect(screen.queryByTestId("player-episode-201")).toBeNull();
  });

  it("клик по текущей серии не гоняет маршрут", () => {
    const onEpisode = vi.fn();
    render(
      <PlayerControls
        {...base({ episodeGroups: TWO_SEASONS, activeEpisode: 101, onEpisode })}
      />,
    );

    fireEvent.click(screen.getByTestId("menu-серии"));
    fireEvent.click(screen.getByTestId("player-episode-101"));

    expect(onEpisode).not.toHaveBeenCalled();
    // Меню всё равно закрылось — иначе выглядит как «клик не сработал».
    expect(screen.queryByTestId("player-episode-102")).toBeNull();
  });

  it("одна группа — заголовков сезонов нет", () => {
    render(
      <PlayerControls
        {...base({
          episodeGroups: [
            {
              heading: "Части",
              episodes: [
                { mediaId: 501, label: "Часть 1", title: null },
                { mediaId: 502, label: "Часть 2", title: null },
              ],
            },
          ],
          activeEpisode: 501,
          onEpisode: () => {},
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("menu-серии"));
    expect(screen.queryAllByTestId("player-season-tab")).toHaveLength(0);
    expect(screen.getByTestId("player-episode-502")).toBeDefined();
  });
});
