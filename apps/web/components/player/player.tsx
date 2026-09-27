"use client";

/**
 * Плеер «Зал»: hls.js + собственный UI. Аудиодорожки, субтитры со сдвигом,
 * резюме просмотра, пропуск интро, автоследующая серия, хоткеи, PiP.
 */
import * as React from "react";
import Hls from "hls.js";
import type { MediaLinks, SpriteMetaDto } from "@zal/api-client";
import { useAuth } from "@/lib/auth";
import {
  activeCues,
  isIntroVisible,
  isNearEnd,
  parseVtt,
  type VttCue,
} from "@/lib/player-logic";
import { PlayerControls } from "./controls";

export interface PlayerNext {
  mediaId: number;
  label: string;
}

export interface PlayerProps {
  links: MediaLinks;
  title: string;
  next?: PlayerNext | null;
}

interface SubtitleTrack {
  index: number;
  label: string;
  url: string | null;
  cues: VttCue[];
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const PROGRESS_INTERVAL_MS = 10_000;
/** Минимум просмотра, чтобы считать позицию осмысленной (резюме тоже с 5с). */
const MIN_REPORT_SECONDS = 5;

export function Player({ links, title, next }: PlayerProps) {
  const { api, tokens } = useAuth();
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const hlsRef = React.useRef<Hls | null>(null);
  const resumeDone = React.useRef(false);

  const [playing, setPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  const [playbackRate, setPlaybackRate] = React.useState(1);
  const [shiftMs, setShiftMs] = React.useState(0);
  const [activeAudio, setActiveAudio] = React.useState(0);
  const [activeSubtitle, setActiveSubtitle] = React.useState<number | null>(null);
  const [subtitles, setSubtitles] = React.useState<SubtitleTrack[]>([]);
  const [cues, setCues] = React.useState<VttCue[]>([]);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [controlsVisible, setControlsVisible] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const bestFile = links.files[0];
  const streamUrl = bestFile?.urls.hls ?? bestFile?.urls.http ?? null;
  const sprites: SpriteMetaDto | null = links.sprites;

  /* ---------- Инициализация HLS ---------- */
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError(`Ошибка воспроизведения: ${data.details}`);
      });
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }
    // Safari и прочие с нативным HLS.
    video.src = streamUrl;
    return () => {
      video.removeAttribute("src");
    };
  }, [streamUrl]);

  /* ---------- Субтитры: загрузка WebVTT ---------- */
  React.useEffect(() => {
    let cancelled = false;
    const tracks: SubtitleTrack[] = links.subtitles.map((s, i) => ({
      index: i,
      label: s.title ?? s.lang.toUpperCase(),
      url: s.url,
      cues: [],
    }));
    setSubtitles(tracks);

    void Promise.all(
      tracks.map(async (t) => {
        if (!t.url) return t;
        try {
          const res = await fetch(t.url);
          if (!res.ok) return t;
          return { ...t, cues: parseVtt(await res.text()) };
        } catch {
          return t;
        }
      }),
    ).then((loaded) => {
      if (cancelled) return;
      setSubtitles(loaded);
      setActiveSubtitle((cur) => {
        if (cur != null) setCues(loaded[cur]?.cues ?? []);
        return cur;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [links.subtitles]);

  /* ---------- События видео ---------- */
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTime = () => setCurrentTime(video.currentTime);
    const onMeta = () => setDuration(video.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVolume);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVolume);
    };
  }, []);

  /* ---------- Резюме: стартуем с сохранённой позиции ---------- */
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !tokens || resumeDone.current) return;
    resumeDone.current = true;
    void api
      .getProgress(links.mediaId)
      .then(({ progress }) => {
        if (
          progress &&
          progress.positionSeconds > 5 &&
          progress.durationSeconds > 0 &&
          progress.positionSeconds / progress.durationSeconds < 0.95
        ) {
          video.currentTime = progress.positionSeconds;
        }
      })
      .catch(() => {});
  }, [api, tokens, links.mediaId]);

  /* ---------- Прогресс: пишем периодически и на паузе ---------- */
  const reportProgress = React.useCallback(() => {
    const video = videoRef.current;
    if (!video || !tokens || !video.duration) return;
    void api
      .saveProgress(links.mediaId, {
        positionSeconds: video.currentTime,
        durationSeconds: video.duration,
      })
      .catch(() => {});
  }, [api, tokens, links.mediaId]);

  React.useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(reportProgress, PROGRESS_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, reportProgress]);

  // Прогресс на паузе и при уходе со страницы — детерминированно, без ожидания интервала.
  // С выгрузки не пишем нулевые позиции: такая зомби-запись затирает свежий прогресс.
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPause = () => reportProgress();
    const onPageHide = () => {
      // С выгрузки пишем только во время воспроизведения: пауза и так записала,
      // а зомби-запись с остановленной страницы затирает свежий прогресс.
      const v = videoRef.current;
      if (v && !v.paused && v.currentTime >= MIN_REPORT_SECONDS) reportProgress();
    };
    video.addEventListener("pause", onPause);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      video.removeEventListener("pause", onPause);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [reportProgress]);

  // При размонтировании (клиентская навигация) сохраняем осмысленную позицию.
  // beforeunload не используем: его зомби-запись при перезагрузке затирает
  // свежий прогресс — выгрузку покрывает pagehide-хук выше.
  React.useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video && video.currentTime >= MIN_REPORT_SECONDS) reportProgress();
    };
  }, [reportProgress]);

  /* ---------- Управление ---------- */
  const togglePlay = React.useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, []);

  const seek = React.useCallback((t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(t, video.duration || t));
    setCurrentTime(video.currentTime);
  }, []);

  const changeVolume = React.useCallback((v: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    video.muted = v === 0;
  }, []);

  const changeRate = React.useCallback((r: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = r;
    setPlaybackRate(r);
  }, []);

  /** Реальное переключение дубляжа: hls.js либо нативные audioTracks (Safari). */
  const changeAudio = React.useCallback((index: number) => {
    const hls = hlsRef.current;
    const video = videoRef.current as (HTMLVideoElement & {
      audioTracks?: { length: number; [i: number]: { enabled: boolean } };
    }) | null;
    if (hls && hls.audioTracks.length > 1) {
      hls.audioTrack = index;
    } else if (video?.audioTracks && video.audioTracks.length > 1) {
      for (let i = 0; i < video.audioTracks.length; i++) {
        video.audioTracks[i]!.enabled = i === index;
      }
    }
    setActiveAudio(index);
  }, []);

  const changeSubtitle = React.useCallback(
    (index: number | null) => {
      setActiveSubtitle(index);
      setCues(index == null ? [] : (subtitles[index]?.cues ?? []));
    },
    [subtitles],
  );

  const togglePip = React.useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
    } catch {
      // PiP недоступен — молча игнорируем.
    }
  }, []);

  const toggleFullscreen = React.useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // fullscren недоступен.
    }
  }, []);

  /* ---------- Хоткеи ---------- */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "arrowright":
          seek((videoRef.current?.currentTime ?? 0) + 5);
          break;
        case "arrowleft":
          seek((videoRef.current?.currentTime ?? 0) - 5);
          break;
        case "l":
          seek((videoRef.current?.currentTime ?? 0) + 10);
          break;
        case "j":
          seek((videoRef.current?.currentTime ?? 0) - 10);
          break;
        case "arrowup":
          e.preventDefault();
          changeVolume(Math.min(1, volume + 0.1));
          break;
        case "arrowdown":
          e.preventDefault();
          changeVolume(Math.max(0, volume - 0.1));
          break;
        case "m":
          changeVolume(muted ? volume || 1 : 0);
          break;
        case "f":
          void toggleFullscreen();
          break;
        case "p":
          void togglePip();
          break;
        case "c":
          changeSubtitle(activeSubtitle == null ? 0 : null);
          break;
        case "[":
          setShiftMs((s) => s - 100);
          break;
        case "]":
          setShiftMs((s) => s + 100);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    togglePlay,
    seek,
    changeVolume,
    changeSubtitle,
    toggleFullscreen,
    togglePip,
    volume,
    muted,
    activeSubtitle,
  ]);

  /* ---------- Автоскрытие контролов ---------- */
  React.useEffect(() => {
    if (!playing) {
      setControlsVisible(true);
      return;
    }
    const id = window.setTimeout(() => setControlsVisible(false), 3000);
    return () => window.clearTimeout(id);
  }, [playing, currentTime]);

  React.useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const activeCueList = activeCues(cues, currentTime, shiftMs);
  const introVisible = isIntroVisible(currentTime, links.intro);
  const nearEnd = isNearEnd(currentTime, duration) && !!next;

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-[var(--radius-card)] bg-black select-none"
      onMouseMove={() => setControlsVisible(true)}
      data-testid="player"
    >
      <video
        ref={videoRef}
        className="aspect-video w-full bg-black"
        onClick={togglePlay}
        playsInline
        data-testid="player-video"
      />

      {/* Субтитры со сдвигом */}
      {activeCueList.length > 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-24 flex flex-col items-center gap-1 px-8 text-center"
          data-testid="subtitle-overlay"
        >
          {activeCueList.map((c, i) => (
            <span
              key={`${c.start}-${i}`}
              className="rounded bg-black/70 px-2 py-1 text-lg font-medium text-white"
            >
              {c.text}
            </span>
          ))}
        </div>
      )}

      {/* Пропустить интро */}
      {introVisible && (
        <button
          className="absolute bottom-28 right-6 rounded-full bg-white/90 px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-white"
          onClick={() => seek(links.intro!.endSeconds)}
          data-testid="skip-intro"
        >
          Пропустить интро
        </button>
      )}

      {/* Следующая серия */}
      {nearEnd && (
        <div
          className="absolute bottom-28 left-6 rounded-[var(--radius-card)] border border-border bg-black/80 p-4"
          data-testid="next-episode"
        >
          <p className="mb-2 text-sm text-muted">Следующая серия</p>
          <button
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
            onClick={() => {
              reportProgress();
              window.location.assign(`/watch/${next!.mediaId}`);
            }}
          >
            {next!.label}
          </button>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white">
          {error}
        </div>
      )}

      <div className={controlsVisible ? "block" : "hidden"}>
        <PlayerControls
          playing={playing}
          currentTime={currentTime}
          duration={duration}
          volume={volume}
          muted={muted}
          playbackRate={playbackRate}
          speeds={SPEEDS}
          shiftMs={shiftMs}
          audioTracks={links.audios.map((a, i) => ({
            index: i,
            label: `${a.type.toUpperCase()}${a.author.title ? ` · ${a.author.title}` : ""} (${a.lang})`,
          }))}
          activeAudio={activeAudio}
          subtitles={subtitles.map((s) => ({ index: s.index, label: s.label }))}
          activeSubtitle={activeSubtitle}
          sprites={sprites}
          spriteUrl={sprites?.url ?? null}
          isFullscreen={isFullscreen}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onVolume={changeVolume}
          onRate={changeRate}
          onAudio={changeAudio}
          onSubtitle={changeSubtitle}
          onShift={(delta) => setShiftMs((s) => s + delta)}
          onPip={() => void togglePip()}
          onFullscreen={() => void toggleFullscreen()}
        />
      </div>
    </div>
  );
}
