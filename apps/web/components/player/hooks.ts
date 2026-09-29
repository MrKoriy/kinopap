"use client";

import type { ApiClient } from "@zal/api-client";
import * as React from "react";
import { type BufferedSegment, bufferedSegments } from "@/lib/player-logic";

/**
 * Эффекты плеера, у которых интерфейс узкий: по паре входов и одному-двум
 * выходам. Всё остальное осталось в `player.tsx` намеренно — инициализация
 * потока читает девятнадцать имён из внешней области (восемь из них —
 * сеттеры состояния), и «вынос» её в хук был бы не расколом, а переносом
 * той же связи в другой файл, да ещё и через лишний слой параметров.
 */

/**
 * Как часто пересчитывать полосу буфера, мс.
 *
 * `progress` на быстром канале сыпется десятки раз в секунду, и каждый вызов —
 * это `setState` и ре-рендер всего контрол-бара. Четырёх раз в секунду полосе
 * хватает с запасом: она меняется на глазах, но не дёргается.
 */
const BUFFER_SNAPSHOT_MS = 250;

const PROGRESS_INTERVAL_MS = 10_000;
/** Минимум просмотра, чтобы считать позицию осмысленной (резюме тоже с 5с). */
const MIN_REPORT_SECONDS = 5;

/**
 * Отрезки буфера в долях длительности — для серой полосы в контрол-баре.
 *
 * `resetKey` — смена источника (адрес потока или эпоха перезапуска). Без сброса
 * от старой раздачи остаётся полоса, которой в новой нет, и она читается как
 * «уже загружено».
 *
 * Слушатели свои и отдельные от остальных событий видео: `progress` не
 * участвует ни в одном другом состоянии.
 */
export function useBufferedRanges(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  resetKey: string,
): BufferedSegment[] {
  const [buffered, setBuffered] = React.useState<BufferedSegment[]>([]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let lastAt = 0;
    const snapshot = () => {
      const now = performance.now();
      // Троттлинг здесь, а не через debounce: нам нужен последний снимок, а не
      // отложенный, иначе полоса отстаёт от видео на хвост задержки.
      if (now - lastAt < BUFFER_SNAPSHOT_MS) return;
      lastAt = now;

      // `video.buffered` — живой TimeRanges: к моменту рендера в нём уже другие
      // числа. Поэтому копируем в обычный массив прямо сейчас.
      const ranges: { start: number; end: number }[] = [];
      for (let i = 0; i < video.buffered.length; i += 1) {
        ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
      }
      setBuffered(bufferedSegments(ranges, video.duration || 0));
    };

    video.addEventListener("progress", snapshot);
    video.addEventListener("timeupdate", snapshot);
    video.addEventListener("loadedmetadata", snapshot);
    video.addEventListener("emptied", snapshot);
    return () => {
      video.removeEventListener("progress", snapshot);
      video.removeEventListener("timeupdate", snapshot);
      video.removeEventListener("loadedmetadata", snapshot);
      video.removeEventListener("emptied", snapshot);
    };
  }, [videoRef]);

  React.useEffect(() => {
    // Читаем явно: сбрасывать надо именно на смену источника, а линтер иначе
    // считает зависимость лишней и предлагает её убрать — тогда эффект
    // перестал бы срабатывать вовсе.
    void resetKey;
    setBuffered([]);
  }, [resetKey]);

  return buffered;
}

/**
 * Запись прогресса просмотра. Чтение резюме здесь намеренно НЕ живёт: оно
 * часть механизма автоплея (ждёт ответа, чтобы не показать начало фильма и
 * только потом прыжок), и вынос его сюда растащил бы одно состояние на два
 * файла.
 *
 * Пишем в четырёх точках, и каждая закрывает свою дыру:
 * — интервалом во время игры (долгий просмотр);
 * — на паузе (детерминированно, не ожидая интервала);
 * — на `pagehide` (уход со страницы) и только во время игры: запись с
 *   остановленной страницы — зомби, она затирает свежий прогресс нулём;
 * — при размонтировании (клиентская навигация на следующую серию).
 * `beforeunload` не используем ровно из-за зомби-записи при перезагрузке.
 */
export function useProgressReporting({
  videoRef,
  mediaId,
  api,
  enabled,
  playing,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mediaId: number;
  api: ApiClient;
  /** Есть вход в аккаунт: гостю сохранять нечего. */
  enabled: boolean;
  playing: boolean;
}): () => void {
  const reportProgress = React.useCallback(() => {
    const video = videoRef.current;
    if (!video || !enabled || !video.duration) return;
    void api
      .saveProgress(mediaId, {
        positionSeconds: video.currentTime,
        durationSeconds: video.duration,
      })
      .catch(() => {});
  }, [api, enabled, mediaId, videoRef]);

  React.useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(reportProgress, PROGRESS_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, reportProgress]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPause = () => reportProgress();
    const onPageHide = () => {
      const v = videoRef.current;
      if (v && !v.paused && v.currentTime >= MIN_REPORT_SECONDS) reportProgress();
    };
    video.addEventListener("pause", onPause);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      video.removeEventListener("pause", onPause);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [reportProgress, videoRef]);

  React.useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video && video.currentTime >= MIN_REPORT_SECONDS) reportProgress();
    };
  }, [reportProgress, videoRef]);

  return reportProgress;
}

/**
 * Команды над самим элементом `<video>`: играть/пауза, перемотка, громкость,
 * скорость, PiP и смена источника с восстановлением позиции.
 *
 * Граница проведена по тому, что нужно команде: здесь только ссылка на видео и
 * два сеттера для синхронизации UI. Выбор дорожки, качества и субтитров
 * остался в компоненте — те команды читают `audios`/`subtitles`/`hlsRef` и
 * меняют по три состояния каждая, это уже «что играть», а не «как управлять».
 */
export function useTransport(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  {
    setCurrentTime,
    setPlaybackRate,
  }: {
    setCurrentTime: (seconds: number) => void;
    setPlaybackRate: (rate: number) => void;
  },
) {
  /** Смена источника (качество/дубляж) с восстановлением позиции. */
  const swapStream = React.useCallback(
    (mutate: () => void) => {
      const video = videoRef.current;
      const prevTime = video?.currentTime ?? 0;
      const wasPlaying = video ? !video.paused : false;
      mutate();

      const onLoaded = () => {
        if (video && prevTime > 0) {
          video.currentTime = prevTime;
          if (wasPlaying) void video.play().catch(() => {});
        }
        video?.removeEventListener("loadedmetadata", onLoaded);
      };
      video?.addEventListener("loadedmetadata", onLoaded);
    },
    [videoRef],
  );

  const togglePlay = React.useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, [videoRef]);

  const seek = React.useCallback(
    (t: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, Math.min(t, video.duration || t));
      setCurrentTime(video.currentTime);
    },
    [setCurrentTime, videoRef],
  );

  const changeVolume = React.useCallback(
    (v: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.volume = v;
      video.muted = v === 0;
    },
    [videoRef],
  );

  const changeRate = React.useCallback(
    (r: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.playbackRate = r;
      setPlaybackRate(r);
    },
    [setPlaybackRate, videoRef],
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
  }, [videoRef]);

  return { swapStream, togglePlay, seek, changeVolume, changeRate, togglePip };
}
