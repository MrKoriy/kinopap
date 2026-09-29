"use client";

import type { ApiClient, MediaLinks, SpriteMetaDto } from "@zal/api-client";
import * as React from "react";
import {
  type BufferedSegment,
  bufferedSegments,
  parseVtt,
  segmentsEqual,
  type SubtitleCue as VttCue,
} from "@/lib/player-logic";

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
  // Последний выставленный снимок: снимок в state — уже история (React может
  // батчить), а ref даёт сравнивать с тем, что реально ушло в контролы.
  const lastSnapshot = React.useRef<BufferedSegment[]>([]);

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
      const next = bufferedSegments(ranges, video.duration || 0);
      // Полоса почти всегда не меняется между тиками — setState с новым
      // массивом рвал бы мемоизацию контролов четыре раза в секунду.
      if (segmentsEqual(lastSnapshot.current, next)) return;
      lastSnapshot.current = next;
      setBuffered(next);
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
    // Иначе после смены источника первый снимок, равный старому по значениям,
    // был бы отброшен сравнением — полоса осталась бы пустой.
    lastSnapshot.current = [];
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

/* ---------- Субтитры ---------- */

export interface SubtitleTrack {
  index: number;
  label: string;
  url: string | null;
  cues: VttCue[];
}

/**
 * Дорожки субтитров: список из media-links, затем подгрузка WebVTT.
 *
 * Возвращает пару как `useState`, а не только список: список дорожек
 * подменяет ещё и инициализация потока — у gst-HLS субтитры встроены в
 * манифест, прямых VTT-урлов у них нет, и подменить список может только тот,
 * кто видит манифест.
 *
 * `cues` наружу не отдаём: они целиком выводятся из «какая дорожка выбрана» и
 * самого списка, а отдельным состоянием неизбежно разъезжались бы с ним —
 * подгрузка приходит позже выбора, и обновлять пришлось бы обе половины.
 *
 * Сеттер отдаётся как есть из `useState`, без обёртки: он попадает в список
 * зависимостей эффекта инициализации потока, и обёртка сделала бы его новым на
 * каждом рендере — поток перезагружался бы вместе с ним.
 */
export function useSubtitleTracks(
  subs: MediaLinks["subtitles"],
): [SubtitleTrack[], React.Dispatch<React.SetStateAction<SubtitleTrack[]>>] {
  const [tracks, setTracks] = React.useState<SubtitleTrack[]>([]);

  // Зависим от содержимого списка, а не от ссылки на массив. Ссылочная
  // зависимость здесь — не придирка: собранный на месте список (а не проп из
  // ответа API) приходит новым массивом на каждом рендере, эффект кладёт в
  // состояние новый массив, тот вызывает рендер — и так до исчерпания памяти.
  // Ловится это не в браузере, а тестом: приложение падало вкладкой.
  const key = subs.map((s) => `${s.id}:${s.url ?? ""}`).join("|");
  const subsRef = React.useRef(subs);
  subsRef.current = subs;

  React.useEffect(() => {
    // Читаем явно: `key` — не значение, а признак смены списка, и линтер иначе
    // считает зависимость лишней и предлагает её убрать, после чего эффект
    // перестал бы срабатывать на новом списке вовсе.
    void key;
    let cancelled = false;
    const initial: SubtitleTrack[] = subsRef.current.map((s, i) => ({
      index: i,
      label: s.title ?? s.lang.toUpperCase(),
      url: s.url,
      cues: [],
    }));
    setTracks(initial);

    void Promise.all(
      initial.map(async (t) => {
        if (!t.url) return t;
        try {
          const res = await fetch(t.url);
          if (!res.ok) return t;
          return { ...t, cues: parseVtt(await res.text()) };
        } catch {
          // Дорожка без реплик лучше упавшего плеера: выбор останется, текста
          // не будет.
          return t;
        }
      }),
    ).then((loaded) => {
      if (cancelled) return;
      setTracks(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return [tracks, setTracks];
}

/* ---------- Клавиатура ---------- */

/**
 * Хоткеи плеера.
 *
 * Отдельным хуком, потому что это единственное место, где раскладка ввода
 * вообще упоминается: таблица клавиш не знает ни про `<video>`, ни про
 * состояние плеера — она превращает нажатие в намерение и передаёт его наверх.
 *
 * Относительная перемотка приходит снаружи как `seekBy`: клавиша не должна
 * знать текущую позицию, иначе хуку понадобилась бы ссылка на видео и он
 * снова сросся бы с ним.
 *
 * `preventDefault` — только там, где браузер сам реагирует на клавишу: пробел
 * прокручивает страницу, стрелки двигают её же. Для `j`/`l`/`m`/`c`/`[`/`]`
 * он не нужен и не вызывается: гасить чужое поведение без нужды нельзя.
 */
export function usePlayerHotkeys(handlers: {
  onTogglePlay: () => void;
  /** Перемотка относительно текущей позиции, секунды. */
  seekBy: (deltaSeconds: number) => void;
  onVolume: (volume: number) => void;
  onSubtitle: (index: number | null) => void;
  onFullscreen: () => void;
  onPip: () => void;
  onShift: (deltaMs: number) => void;
  volume: number;
  muted: boolean;
  /** Субтитры включены — клавиша `c` их тогда выключает. */
  subtitlesOn: boolean;
}): void {
  const {
    onTogglePlay,
    seekBy,
    onVolume,
    onSubtitle,
    onFullscreen,
    onPip,
    onShift,
    volume,
    muted,
    subtitlesOn,
  } = handlers;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Пока курсор в поле ввода, буквы принадлежат полю, а не плееру.
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          onTogglePlay();
          break;
        case "arrowright":
          e.preventDefault();
          seekBy(5);
          break;
        case "arrowleft":
          e.preventDefault();
          seekBy(-5);
          break;
        case "l":
          seekBy(10);
          break;
        case "j":
          seekBy(-10);
          break;
        case "arrowup":
          e.preventDefault();
          onVolume(Math.min(1, volume + 0.1));
          break;
        case "arrowdown":
          e.preventDefault();
          onVolume(Math.max(0, volume - 0.1));
          break;
        case "m":
          // Выключенный звук помним: `m` возвращает прежнюю громкость, а не 1.
          onVolume(muted ? volume || 1 : 0);
          break;
        case "f":
          void onFullscreen();
          break;
        case "p":
          void onPip();
          break;
        case "c":
          onSubtitle(subtitlesOn ? null : 0);
          break;
        case "[":
          onShift(-100);
          break;
        case "]":
          onShift(100);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    onTogglePlay,
    seekBy,
    onVolume,
    onSubtitle,
    onFullscreen,
    onPip,
    onShift,
    volume,
    muted,
    subtitlesOn,
  ]);
}

/* ---------- Превью при перемотке ---------- */

/**
 * Живое превью при перемотке (стримы без спрайта).
 *
 * Для zero-storage стримов спрайта нет: второй `<video>` с SEEK по позиции
 * курсора рисует реальный кадр (Range-запросы к TorrServer). У hls-раздачи
 * прямого адреса нет, поэтому превью не рисуется — условие зависит от
 * `urls.hls`, а не только от наличия спрайта.
 */
export function useScrubPreview(
  sprites: SpriteMetaDto | null,
  file: Pick<MediaLinks["files"][number], "urls"> | undefined,
): {
  previewRef: React.RefObject<HTMLVideoElement | null>;
  previewSrc: string | null;
  onScrubTime: (seconds: number | null) => void;
} {
  const previewRef = React.useRef<HTMLVideoElement | null>(null);
  const previewSrc = sprites || !file || file.urls.hls ? null : file.urls.http || null;

  const onScrubTime = React.useCallback((t: number | null) => {
    const pv = previewRef.current;
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

  return { previewRef, previewSrc, onScrubTime };
}
