"use client";

import type { MediaLinks, SpriteMetaDto } from "@zal/api-client";
import type HlsJs from "hls.js";
/**
 * Плеер «Зал»: hls.js + собственный UI. Аудиодорожки, субтитры со сдвигом,
 * резюме просмотра, пропуск интро, автоследующая серия, хоткеи, PiP.
 * hls.js грузится динамически: браузеры с нативным HLS не тянут ~150КБ в чанк.
 */
import * as React from "react";
import { useAuth } from "@/lib/auth";
import {
  activeCues,
  isIntroVisible,
  isNearEnd,
  parseVtt,
  type SubtitleCue as VttCue,
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
  const { api, isAuthed } = useAuth();
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const hlsRef = React.useRef<HlsJs | null>(null);
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
  const [isBuffering, setIsBuffering] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [activeFileIndex, setActiveFileIndex] = React.useState(0);

  const activeFile = links.files[activeFileIndex] ?? links.files[0];
  const streamUrl = activeFile?.urls.hls ?? activeFile?.urls.http ?? null;
  const sprites: SpriteMetaDto | null = links.sprites;

  /* ---------- Инициализация потока (HLS или прямой HTTP Range) ---------- */
  const activeAudioRef = React.useRef(0);
  activeAudioRef.current = activeAudio;

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    setError(null);
    setIsBuffering(true);

    const isHls = streamUrl.includes(".m3u8") || Boolean(activeFile?.urls.hls);
    // MSE доступен → грузим hls.js динамически; нативный HLS (iOS Safari)
    // играет напрямую, не скачивая ~150КБ библиотеки.
    const canMse = typeof MediaSource !== "undefined";

    let cancelled = false;
    let hls: HlsJs | null = null;

    void (async () => {
      if (isHls && canMse) {
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;
        hls = new Hls({
          enableWorker: true,
          // Буфер: вперед до 2 минут, позади минута — на хорошем канале
          // hls.js должен напарываться вперёд, а не доигрывать по сегменту.
          maxBufferLength: 30,
          maxMaxBufferLength: 120,
          backBufferLength: 60,
          // Оптимистичная стартовая оценка канала (2.5 Мбит/с) — иначе ABR
          // после старта держит 480p и повышает качество медленно.
          abrEwmaDefaultEstimate: 2_500_000,
        });
        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsBuffering(false);
          // После смены качества дорожка сбрасывается на дефолтную —
          // восстанавливаем выбранную пользователем.
          if (hls && hls.audioTracks.length > 1 && activeAudioRef.current > 0) {
            hls.audioTrack = activeAudioRef.current;
          }
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal || !hls) return;
          // Транзиентные сбои — норма для торрента-стрима: один блып не должен
          // вешать плеер до перезагрузки страницы.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          setIsBuffering(false);
          setError(`Ошибка воспроизведения HLS: ${data.details}`);
        });
        return;
      }

      // Safari или прямой HTTP Range-стрим (TorrServer / MP4)
      video.src = streamUrl;
      video.load();
    })();

    return () => {
      cancelled = true;
      hls?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
    };
  }, [streamUrl, activeFile]);

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
    const onMeta = () => {
      setDuration(video.duration || 0);
      setIsBuffering(false);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onPlaying = () => {
      setIsBuffering(false);
      setError(null);
    };
    const onWaiting = () => setIsBuffering(true);
    const onCanPlay = () => setIsBuffering(false);
    const onError = () => {
      setIsBuffering(false);
      const err = video.error;
      if (err?.code === 4) {
        setError(
          "Браузер не поддерживает кодек этого видеофайла (MKV / AC3 аудио). Рекомендуем открыть поток в VLC или IINA через кнопку ниже.",
        );
      } else if (err) {
        setError(`Ошибка воспроизведения видео (код ${err.code}): ${err.message || "сбой загрузки"}`);
      }
    };
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("error", onError);
    video.addEventListener("volumechange", onVolume);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("error", onError);
      video.removeEventListener("volumechange", onVolume);
    };
  }, []);

  /* ---------- Резюме: стартуем с сохранённой позиции ---------- */
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !isAuthed || resumeDone.current) return;
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
  }, [api, isAuthed, links.mediaId]);

  /* ---------- Прогресс: пишем периодически и на паузе ---------- */
  const reportProgress = React.useCallback(() => {
    const video = videoRef.current;
    if (!video || !isAuthed || !video.duration) return;
    void api
      .saveProgress(links.mediaId, {
        positionSeconds: video.currentTime,
        durationSeconds: video.duration,
      })
      .catch(() => {});
  }, [api, isAuthed, links.mediaId]);

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

  const changeQuality = React.useCallback((index: number) => {
    const video = videoRef.current;
    const prevTime = video?.currentTime ?? 0;
    const wasPlaying = video ? !video.paused : false;
    setActiveFileIndex(index);

    const onLoaded = () => {
      if (video && prevTime > 0) {
        video.currentTime = prevTime;
        if (wasPlaying) void video.play().catch(() => {});
      }
      video?.removeEventListener("loadedmetadata", onLoaded);
    };
    video?.addEventListener("loadedmetadata", onLoaded);
  }, []);

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
          e.preventDefault();
          seek((videoRef.current?.currentTime ?? 0) + 5);
          break;
        case "arrowleft":
          e.preventDefault();
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
  // Раньше currentTime был в deps: таймаут пересоздавался на каждом
  // timeupdate (~4 раза в секунду) и никогда не срабатывал.
  React.useEffect(() => {
    if (!playing) {
      setControlsVisible(true);
      return;
    }
    const id = window.setTimeout(() => setControlsVisible(false), 3000);
    return () => window.clearTimeout(id);
  }, [playing]);

  React.useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* ---------- Живое превью при перемотке (стримы без спрайта) ---------- */
  // Для zero-storage стримов спрайта нет: второй <video> с SEEK по позиции
  // курсора рисует реальный кадр (Range-запросы к TorrServer).
  const previewVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const previewSrc =
    sprites || !activeFile || activeFile.urls.hls ? null : activeFile.urls.http;

  const handleScrubTime = React.useCallback((t: number | null) => {
    const pv = previewVideoRef.current;
    if (!pv || t == null || !Number.isFinite(t)) return;
    // Сики с шагом от 0.8с — не спамим торрсервер рейндж-запросами.
    if (Math.abs(pv.currentTime - t) > 0.8 && t > 0) {
      try {
        pv.currentTime = t;
      } catch {
        // Метаданные ещё не готовы — молча пропускаем этот тик.
      }
    }
  }, []);

  const scrubPreview = previewSrc ? (
    <video
      ref={previewVideoRef}
      src={previewSrc}
      muted
      playsInline
      preload="metadata"
      className="h-full w-full object-cover"
    />
  ) : null;

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
        preload="auto"
        aria-label={title}
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
          type="button"
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
            type="button"
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

      {/* Индикатор буферизации */}
      {isBuffering && !error && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/40 text-white">
          <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <p className="text-sm font-medium text-white/90">Буферизация потока / поиск пиров в сети...</p>
        </div>
      )}

      {/* Ошибка воспроизведения с кнопками внешних плееров */}
      {error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/90 p-6 text-center text-white">
          <div className="max-w-md">
            <h3 className="mb-2 text-base font-semibold text-white">Воспроизведение в браузере ограничено</h3>
            <p className="mb-5 text-sm text-muted">{error}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {streamUrl && (
                <>
                  <a
                    href={`iina://weblink?url=${encodeURIComponent(streamUrl)}`}
                    className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover"
                  >
                    Открыть в IINA (Mac)
                  </a>
                  <a
                    href={`vlc://${streamUrl}`}
                    className="rounded-full border border-border bg-surface-elevated px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
                  >
                    Открыть в VLC
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      if (streamUrl) {
                        navigator.clipboard.writeText(streamUrl);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }
                    }}
                    className="rounded-full border border-border bg-surface px-4 py-2 text-sm text-white/80 transition hover:bg-white/10"
                  >
                    {copied ? "Ссылка скопирована" : "Скопировать поток"}
                  </button>
                </>
              )}
            </div>
          </div>
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
          qualities={links.files.map((f, i) => ({
            index: i,
            label: f.quality,
          }))}
          activeQuality={activeFileIndex}
          onQuality={changeQuality}
          sprites={sprites}
          spriteUrl={sprites?.url ?? null}
          scrubPreview={scrubPreview}
          onScrubTime={handleScrubTime}
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
