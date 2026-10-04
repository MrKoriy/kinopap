"use client";

import type { AudioTrack, MediaLinks, SpriteMetaDto } from "@zal/api-client";
import { PLAYBACK_SPEEDS, pollMediaTracks } from "@zal/shared";
import type HlsJs from "hls.js";
import { useRouter } from "next/navigation";
/**
 * Плеер «kino.pap»: hls.js + собственный UI. Аудиодорожки, субтитры со сдвигом,
 * резюме просмотра, пропуск интро, автоследующая серия, хоткеи, PiP.
 * hls.js грузится динамически: браузеры с нативным HLS не тянут ~150КБ в чанк.
 *
 * Здесь осталось то, что нельзя разложить: состояния у плеера двадцать с
 * лишним, и инициализация потока читает девятнадцать имён из внешней области
 * (восемь из них — сеттеры). Показ вынесен в `overlays.tsx`, узкие по
 * интерфейсу эффекты — в `hooks.ts`, чистая арифметика — в `player-logic.ts`.
 */
import * as React from "react";
import { useAuth } from "@/lib/auth";
import { audioLabel, getAudioPref, getGuestProgress, setAudioPref } from "@/lib/guest-progress";
import {
  absoluteStreamUrl,
  activeCues,
  isIntroVisible,
  isNearEnd,
  nextAliveSource,
  nextEpisode,
  type PlayerEpisodeGroup,
  pickInitialFileIndex,
  resolveStreamUrl,
} from "@/lib/player-logic";
import { useCast } from "./cast";
import { PlayerControls, PlayerTimeContext } from "./controls";
import {
  useBufferedRanges,
  usePlayerHotkeys,
  useProgressReporting,
  useScrubPreview,
  useSubtitleTracks,
  useTransport,
} from "./hooks";
import { LoadingStages } from "./loading-stages";
import {
  BufferingOverlay,
  NextEpisodeOverlay,
  PlaybackError,
  SkipIntroButton,
  SubtitleOverlay,
  UnmuteOverlay,
} from "./overlays";
import { StreamReportButton } from "./report-button";
import { useStreamSetup } from "./stream-init";

/** Скрываем контролы после стольких секунд бездействия (мышь или палец). */
const CONTROLS_HIDE_MS = 5000;

export interface PlayerProps {
  links: MediaLinks;
  title: string;
  /**
   * Серии тайтла для меню выбора. Пусто у фильма — тогда меню не рисуется.
   *
   * «Следующая серия» выводится из этого же списка, а не приходит отдельным
   * пропом: иначе оверлей и соседний пункт меню могли бы указывать на разные
   * серии, и расхождение всплыло бы только на стыке сезонов.
   */
  episodeGroups?: PlayerEpisodeGroup[];
  /** mediaId текущей серии — по нему находим её место в списке. */
  currentMediaId?: number;
  /** Первое реальное воспроизведение: watch-страница греет следующую серию. */
  onPlaybackStart?: () => void;
  /** Жалоба «не играет / не та серия» принята — пора перезапросить ссылки. */
  onSourceReported?: () => void;
}

export function Player({
  links,
  title,
  episodeGroups,
  currentMediaId,
  onPlaybackStart,
  onSourceReported,
}: PlayerProps) {
  const { api, isAuthed } = useAuth();
  const router = useRouter();
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const hlsRef = React.useRef<HlsJs | null>(null);
  // mediaId, для которого резюме уже применено (per-media, не per-mount).
  const resumeDone = React.useRef<number | null>(null);

  const [playing, setPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  const [playbackRate, setPlaybackRate] = React.useState(1);
  const [shiftMs, setShiftMs] = React.useState(0);
  const [activeAudio, setActiveAudio] = React.useState(0);
  // Ленивые аудио-дорожки: gst-проба идёт фоном, пока видео уже играет.
  const [lazyAudios, setLazyAudios] = React.useState<AudioTrack[]>([]);
  const [activeSubtitle, setActiveSubtitle] = React.useState<number | null>(null);
  const [subtitles, setSubtitles] = useSubtitleTracks(links.subtitles);
  // Реплики не отдельным состоянием, а выводом из выбранной дорожки: VTT
  // приезжает позже выбора, и два независимых состояния разъезжались бы —
  // выбор обновился, текст нет.
  const cues = activeSubtitle == null ? [] : (subtitles[activeSubtitle]?.cues ?? []);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [controlsVisible, setControlsVisible] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [isBuffering, setIsBuffering] = React.useState(false);
  // Старт источника: «подключаемся» (до метаданных) → «буферизуем» (до
  // canplay/playing) → готово. Источник уже найден (links есть), поэтому
  // первый этап «ищем источник» здесь всегда пройден.
  const [startPhase, setStartPhase] = React.useState<"connect" | "buffer" | "done">("connect");
  // gst-HLS недоступен (транскодер упал / версия без gst) — откат на прямой
  // HTTP-стрим: картинка и звук родными кодеками есть не у всех браузеров,
  // но это лучше, чем чёрный экран.
  const [directFallback, setDirectFallback] = React.useState(false);
  // Автоплей заблокирован политикой браузера — играем без звука и показываем
  // кнопку «Включить звук», чтобы пользователь не остался с тишиной без выхода.
  const [soundBlocked, setSoundBlocked] = React.useState(false);
  // Раздачи, которые уже не заиграли: gst-транскодер отказал и прямой стрим не
  // пошёл. Перебираем список, пока не найдём рабочую.
  //
  // Зачем: резолвер отдаёт до восьми раздач одного фильма, отсортированных по
  // сидам и размеру, но НЕ проверяет, транскодируется ли файл. DVD-remux с
  // MPEG-2 gst не берёт вовсе («unsupported video codec»), а стоит он первым —
  // и фильм закрыт целиком, хотя рядом лежат пять рабочих раздач. Раньше плеер
  // восемь раз долбился в один и тот же мёртвый URL и показывал «браузер не
  // поддерживает MKV / AC3», что неправда: браузер тут ни при чём.
  const [deadFiles, setDeadFiles] = React.useState<number[]>([]);
  // Идёт перебор: показываем это пользователю, чтобы пауза не выглядела зависанием.
  const [switchingSource, setSwitchingSource] = React.useState(false);
  // Растёт по «Попробовать снова»: перезапускает инициализацию потока, даже
  // если индекс раздачи не изменился (setActiveFileIndex(0) при нуле — no-op).
  const [sourceEpoch, setSourceEpoch] = React.useState(0);

  // Стартуем с самой лёгкой раздачи: пока доступ из РФ идёт через VPN с узким
  // каналом, 30-ГБ ремукс на холодных пирах может не выйти из буферизации
  // дольше, чем длится просмотр (см. pickInitialFileIndex).
  const [activeFileIndex, setActiveFileIndex] = React.useState(() =>
    pickInitialFileIndex(links.files),
  );

  const activeFile = links.files[activeFileIndex] ?? links.files[0];
  // Дубляж zero-storage: каждая дорожка — персональный HLS-мастер
  // (gst выбирает аудио параметром URL), переключаемся сменой источника.
  // Дорожки приходят лениво (media-tracks) — до них играем базовым мастером.
  const audios = lazyAudios.length > 0 ? lazyAudios : links.audios;
  // Нулевая дорожка — это базовый мастер, а не отдельная дорожка: у
  // ингест-тайтлов ей соответствует общий манифест.
  const audioMaster = activeAudio > 0 ? audios[activeAudio]?.masterUrl : null;
  const streamUrl = resolveStreamUrl({ file: activeFile, directFallback, audioMaster });
  const sprites: SpriteMetaDto | null = links.sprites;
  // Следующая серия — из того же списка, что и меню выбора, чтобы оверлей и
  // соседний пункт меню не могли разойтись. itemId для маршрута берём из links:
  // плеер всегда знает, к какому тайтлу относится играющее медиа.
  const next = React.useMemo(
    () =>
      episodeGroups && currentMediaId != null
        ? nextEpisode(episodeGroups, currentMediaId)
        : null,
    [episodeGroups, currentMediaId],
  );

  /* ---------- Ленивые аудио-дорожки (gst-проба в фоне) ---------- */
  React.useEffect(() => {
    // У ингест-тайтлов дорожки уже в media-links — второй раз не спрашиваем.
    if (links.audios.length > 0 || lazyAudios.length > 0) return;
    // Лестница таймингов общая с мобильным клиентом (@zal/shared):
    // 4с до первой пробы (gst читает ту же голову файла, что и первый
    // сегмент) → 2 ретрая с шагом 8с, пока прогрев едет.
    return pollMediaTracks(
      () => api.getMediaTracks(links.itemId, links.mediaId),
      (audios) => setLazyAudios(audios),
    );
  }, [api, lazyAudios.length, links.audios.length, links.itemId, links.mediaId]);

  /* ---------- Автозапуск: играем сами, звук — если браузер разрешит ---------- */
  // Одна попытка на media: смена качества/дубляжа перезагружает манифест и не
  // должна превращаться в повторный автоплей после ручной паузы пользователя.
  const autoplayForMedia = React.useRef<number | null>(null);
  const playbackStartNotified = React.useRef(false);
  // Резюме приходит отдельным запросом позже манифеста. Если стартовать
  // сразу, зритель увидит начало фильма и только потом прыжок на сохранённую
  // позицию — поэтому автоплей ждёт ответа по прогрессу (см. эффект ниже).
  const resumeSettled = React.useRef<number | null>(null);
  const onPlaybackStartRef = React.useRef(onPlaybackStart);
  onPlaybackStartRef.current = onPlaybackStart;

  // iPad/Safari требует жеста для звука. Блокировку ловим сразу на
  // `tryAutoplay()` — там, где манифест уже готов, — и ставим заголовок
  // `muted` заранее (иначе нативный HLS стартует с ошибкой до первого play).
  // Обычный десктоп CHrome/Firefox здесь проходит без звука с первой попытки.
  const tryAutoplay = React.useCallback(() => {
    const video = videoRef.current;
    if (!video || autoplayForMedia.current === links.mediaId) return;
    // Авторизованный ждёт, пока позиция будет применена (или запрос упадёт).
    if (isAuthed && resumeSettled.current !== links.mediaId) return;
    autoplayForMedia.current = links.mediaId;
    void video.play().then(
      () => setSoundBlocked(false),
      (err: unknown) => {
        const name = err instanceof Error ? err.name : "";
        if (name !== "NotAllowedError") return;
        // iPad: первый play со звуком заблокирован — приглушаем заголовок,
        // перезапускаем play и показываем кнопку «Включить звук».
        video.muted = true;
        setMuted(true);
        void video.play().then(
          () => setSoundBlocked(true),
          () => {
            // Иногда даже muted-play блокируется (Low Power Mode / запрет
            // автоплея в настройках Safari). Откат нужен, иначе видео останется
            // приглушённым без оверлея.
            video.muted = false;
            setMuted(false);
          },
        );
      },
    );
  }, [links.mediaId, isAuthed]);
  const tryAutoplayRef = React.useRef(tryAutoplay);
  tryAutoplayRef.current = tryAutoplay;

  const unmute = React.useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    setMuted(false);
    setSoundBlocked(false);
  }, []);

  /* ---------- Инициализация потока (HLS или прямой HTTP Range) ---------- */
  const activeAudioRef = React.useRef(0);
  activeAudioRef.current = activeAudio;
  const activeSubtitleRef = React.useRef<number | null>(null);
  activeSubtitleRef.current = activeSubtitle;
  // Ретраи gst-манифеста до отката на прямой стрим: транскодеру нужен тёплый
  // торрент, первая попытка сразу после резолва может не успеть.
  const gstRetryRef = React.useRef(0);

  const activeFileIndexRef = React.useRef(activeFileIndex);
  activeFileIndexRef.current = activeFileIndex;
  const deadFilesRef = React.useRef<number[]>([]);
  deadFilesRef.current = deadFiles;

  /**
   * Помечает текущую раздачу мёртвой и переключает на следующую неиспробованную.
   * Когда живых не осталось — только тогда показываем ошибку.
   */
  const abandonCurrentFile = React.useCallback(() => {
    const current = activeFileIndexRef.current;
    // Уже помечена — переключение на неё ещё не завершилось, а это эхо ошибки
    // от предыдущей раздачи. Без этой проверки одна ошибка съедала бы сразу
    // две раздачи из списка.
    if (deadFilesRef.current.includes(current)) return;
    const dead = [...deadFilesRef.current, current];
    deadFilesRef.current = dead;
    setDeadFiles(dead);

    const next = nextAliveSource(dead, links.files.length);

    if (next == null) {
      setSwitchingSource(false);
      setIsBuffering(false);
      setError(
        "Ни одна раздача этого фильма не заиграла. Попробуйте открыть позже — торренты оживут — или выберите другое качество в меню.",
      );
      return;
    }

    setSwitchingSource(true);
    // Счётчик ретраев и откат на прямой стрим — свои для каждой раздачи:
    // иначе новая раздача получила бы бюджет ретраев предыдущей.
    gstRetryRef.current = 0;
    setDirectFallback(false);
    // Автоплей — одноразовый на mediaId (чтобы не спорить с ручной паузой).
    // Перебор раздачи — исключение: пользователь просил играть, поэтому снимаем
    // флаг, иначе новая раздача распарсит манифест и встанет на паузе.
    autoplayForMedia.current = null;
    setActiveFileIndex(next);
  }, [links.files.length]);

  // Ссылка, чтобы вызывать из слушателей hls.js и <video>, не пересоздавая их.
  const abandonRef = React.useRef(abandonCurrentFile);
  abandonRef.current = abandonCurrentFile;

  /**
   * «Попробовать снова» после того, как перебрали все раздачи: список мог
   * устареть (торренты оживают, gst прогревается), поэтому начинаем с чистого
   * листа, а не показываем тупик.
   */
  const retryAllSources = React.useCallback(() => {
    deadFilesRef.current = [];
    setDeadFiles([]);
    setError(null);
    setDirectFallback(false);
    setSwitchingSource(false);
    setIsBuffering(true);
    gstRetryRef.current = 0;
    // Явная просьба играть — снимаем одноразовый флаг автоплея (см. выше).
    autoplayForMedia.current = null;
    setActiveFileIndex(pickInitialFileIndex(links.files));
    setSourceEpoch((n) => n + 1);
  }, [links.files]);

  // Новый источник (другая раздача/качество/повтор) — этапы старта заново.
  // sourceEpoch в условии — «Попробовать снова» на том же URL тоже сброс.
  React.useEffect(() => {
    if (streamUrl && sourceEpoch >= 0) setStartPhase("connect");
  }, [streamUrl, sourceEpoch]);

  useStreamSetup({
    videoRef,
    hlsRef,
    streamUrl,
    activeFile,
    directFallback,
    sourceEpoch,
    setError,
    setIsBuffering,
    setDirectFallback,
    setSubtitles,
    gstRetryRef,
    tryAutoplayRef,
    activeAudioRef,
    activeSubtitleRef,
    abandonRef,
  });

  /* ---------- События видео ---------- */
  // Таймер ретрая video.load(): гасим при размонтировании, иначе колбэк
  // выстрелит по уже отсоединённому <video>.
  const loadRetryTimerRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTime = () => setCurrentTime(video.currentTime);
    const onMeta = () => {
      setDuration(video.duration || 0);
      setIsBuffering(false);
      setStartPhase((p) => (p === "connect" ? "buffer" : p));
      // Прямой HTTP-стрим узнаёт о готовности только здесь — пробуем play.
      tryAutoplayRef.current();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onPlaying = () => {
      setIsBuffering(false);
      setStartPhase("done");
      setError(null);
      // Раздача заиграла — перебор закончен, убираем плашку «пробуем другую».
      setSwitchingSource(false);
      if (!playbackStartNotified.current) {
        playbackStartNotified.current = true;
        onPlaybackStartRef.current?.();
      }
    };
    const onWaiting = () => setIsBuffering(true);
    const onCanPlay = () => {
      setIsBuffering(false);
      // Готово к показу: дальше ждём уже не сеть, а play (автоплей/клик).
      setStartPhase("done");
    };
    const onError = () => {
      setIsBuffering(false);
      const err = video.error;
      if (!err) return;

      // Нативный HLS (Safari): манифест, который gst ещё не собрал, приходит
      // как код 4 «источник не поддерживается» или код 2 — как обычный сетевой
      // сбой. Даём транскодеру тот же бюджет ретраев, что был у hls.js-пути,
      // иначе первая же холодная раздача сгорала за секунды и перебор
      // прокручивал весь список фильмов до ошибки.
      const nativePath = !hlsRef.current;
      if (nativePath && (err.code === 2 || err.code === 4) && gstRetryRef.current < 3) {
        gstRetryRef.current += 1;
        setIsBuffering(true);
        loadRetryTimerRef.current = window.setTimeout(() => {
          loadRetryTimerRef.current = null;
          video.load();
          tryAutoplayRef.current();
        }, 2_000);
        return;
      }

      // Код 2 — сетевой сбой, он бывает транзиентным: одна повторная попытка
      // на раздачу. Коды 3 и 4 — декодер и «источник не поддерживается»:
      // этот файл не заиграет никогда, ждать нечего.
      if (err.code === 2 && gstRetryRef.current < 1) {
        gstRetryRef.current += 1;
        setIsBuffering(true);
        loadRetryTimerRef.current = window.setTimeout(() => {
          loadRetryTimerRef.current = null;
          video.load();
          tryAutoplayRef.current();
        }, 1_500);
        return;
      }

      // Прямой стрим — последний рубеж для этой раздачи. Не пошёл — берём
      // следующую. Раньше здесь показывалось «браузер не поддерживает MKV /
      // AC3», что сбивало с толку: проблема была в конкретной раздаче, а не
      // в браузере, и рядом лежали рабочие.
      abandonRef.current();
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
      if (loadRetryTimerRef.current !== null) {
        window.clearTimeout(loadRetryTimerRef.current);
        loadRetryTimerRef.current = null;
      }
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

  /* ---------- Буфер: серая полоса в контрол-баре ---------- */
  // Смена источника — новый буфер: без сброса от старой раздачи остаётся
  // полоса, которой в новой нет, и она читается как «уже загружено».
  const buffered = useBufferedRanges(videoRef, `${streamUrl ?? ""}|${sourceEpoch}`);

  /* ---------- Резюме: стартуем с сохранённой позиции ---------- */
  React.useEffect(() => {
    const video = videoRef.current;
    // Per-media: при клиентской навигации на следующую серию плеер может
    // пережить смену источника и обязан заново применить резюме.
    if (!video || resumeDone.current === links.mediaId) return;
    resumeDone.current = links.mediaId;
    if (!isAuthed) {
      // Гость: позиция из localStorage.
      const g = getGuestProgress(links.mediaId);
      if (g && g.positionSeconds > 5 && g.durationSeconds > 0 && g.positionSeconds / g.durationSeconds < 0.95) {
        video.currentTime = g.positionSeconds;
      }
      resumeSettled.current = links.mediaId;
      return;
    }
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
      .catch(() => {})
      .finally(() => {
        // Позиция известна (или запрос упал) — теперь можно играть.
        resumeSettled.current = links.mediaId;
        tryAutoplayRef.current();
      });
  }, [api, isAuthed, links.mediaId]);

  /* ---------- Прогресс: пишем периодически и на паузе ---------- */
  // Хук зовём именно здесь, а не рядом с остальными: его эффект размонтирования
  // читает `video.currentTime` и обязан отработать РАНЬШЕ, чем эффект
  // инициализации потока снимет `src`. Поднять его выше по файлу — и последняя
  // позиция перестанет сохраняться при клиентской навигации: cleanup'ы идут в
  // обратном порядке регистрации, и нулевая позиция не пройдёт порог в 5с.
  const reportProgress = useProgressReporting({
    videoRef,
    itemId: links.itemId,
    mediaId: links.mediaId,
    api,
    enabled: isAuthed,
    playing,
  });

  // Выбор серии в меню: тот же переход, что и у «Следующей серии», — страница
  // просмотра пересоздаёт плеер по key={itemId:mediaId}. Прогресс фиксируем до
  // ухода, иначе последние секунды текущей серии теряются.
  const changeEpisode = React.useCallback(
    (mediaId: number) => {
      reportProgress();
      router.push(`/watch/${links.itemId}/${mediaId}`);
    },
    [links.itemId, reportProgress, router],
  );

  /* ---------- Управление ---------- */

  // Команды над самим <video>: play/pause, перемотка, громкость, скорость, PiP
  // и смена источника с восстановлением позиции. Что играть (дорожка, качество,
  // субтитры) — ниже: те команды читают audios/subtitles/hlsRef и меняют по три
  // состояния каждая, у них общего с транспортом только имя.
  const { swapStream, togglePlay, seek, changeVolume, changeRate, togglePip } = useTransport(
    videoRef,
    { setCurrentTime, setPlaybackRate },
  );

  /** Реальное переключение дубляжа: hls.js либо нативные audioTracks (Safari). */
  const changeAudio = React.useCallback(
    (index: number) => {
      // zero-storage: дорожки с masterUrl переключаются сменой источника
      // (gst выбирает аудио параметром URL); сброс на 0 — базовый мастер.
      if (audios.some((a) => a.masterUrl)) {
        swapStream(() => {
          setDirectFallback(false);
          setActiveAudio(index);
        });
        return;
      }
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
    },
    [audios, swapStream],
  );

  // Выбор дубляжа пользователем запоминаем на тайтл — следующая серия
  // стартует с той же озвучкой.
  const pickAudio = React.useCallback(
    (index: number) => {
      const a = audios[index];
      if (a) setAudioPref(links.itemId, audioLabel(a));
      changeAudio(index);
    },
    [audios, changeAudio, links.itemId],
  );

  const audioPrefApplied = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (audios.length < 2 || audioPrefApplied.current === links.mediaId) return;
    audioPrefApplied.current = links.mediaId;
    const pref = getAudioPref(links.itemId);
    if (!pref) return;
    const idx = audios.findIndex((a) => audioLabel(a) === pref);
    if (idx > 0 && idx !== activeAudioRef.current) changeAudio(idx);
  }, [audios, changeAudio, links.itemId, links.mediaId]);

  const changeSubtitle = React.useCallback(
    (index: number | null) => {
      // Встроенные субтитры gst-HLS — треки манифеста, рендерит hls.js.
      const hls = hlsRef.current;
      if (hls && hls.subtitleTracks.length > 0 && subtitles[index ?? 0]?.url == null) {
        hls.subtitleTrack = index ?? -1;
      }
      setActiveSubtitle(index);
    },
    [subtitles],
  );

  const changeQuality = React.useCallback(
    (index: number) => {
      // Дорожки привязаны к прогретому релизу — при смене качества
      // возвращаем дефолтную дорожку и gst-стрим.
      swapStream(() => {
        setActiveAudio(0);
        setDirectFallback(false);
        setActiveFileIndex(index);
      });
    },
    [swapStream],
  );

  // Fullscreen — на контейнере, а не на <video>: вместе с видео уходят и
  // контролы, и оверлеи. Поэтому он не в useTransport.
  //
  // В standalone-PWA на iOS/iPadOS Fullscreen API для элементов недоступен
  // (это не баг сайта — WebKit так устроен): requestFullscreen отсутствует
  // или кидает. Тогда разворачиваем контейнер сами — fixed inset-0 поверх
  // страницы, контролы остаются наши.
  const [cssFullscreen, setCssFullscreen] = React.useState(false);
  const toggleFullscreen = React.useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    if (cssFullscreen || document.fullscreenElement) {
      setCssFullscreen(false);
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // выход из fullscreen недоступен — не страшно
      }
      return;
    }
    if (typeof el.requestFullscreen === "function") {
      try {
        await el.requestFullscreen();
        return;
      } catch {
        // fell through к CSS-фолбэку
      }
    }
    setCssFullscreen(true);
  }, [cssFullscreen]);

  // CSS-fullscreen накрывает страницу — гасим прокрутку фона под ним.
  React.useEffect(() => {
    if (!cssFullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [cssFullscreen]);

  /* ---------- Хоткеи ---------- */
  // Клавиша не знает ни позиции, ни элемента — только намерение. Относительную
  // перемотку считаем здесь, где позиция под рукой.
  const seekBy = React.useCallback(
    (delta: number) => seek((videoRef.current?.currentTime ?? 0) + delta),
    [seek],
  );
  const shiftSubtitles = React.useCallback(
    (deltaMs: number) => setShiftMs((s) => s + deltaMs),
    [],
  );

  usePlayerHotkeys({
    onTogglePlay: togglePlay,
    seekBy,
    onVolume: changeVolume,
    onSubtitle: changeSubtitle,
    onFullscreen: toggleFullscreen,
    onPip: togglePip,
    onShift: shiftSubtitles,
    volume,
    muted,
    subtitlesOn: activeSubtitle != null,
  });

  /* ---------- Автоскрытие контролов ---------- */
  // Таймер взводится при каждом показе контролов. Раньше deps был только
  // [playing]: таймаут ставился один раз на переход play, и после первого
  // скрытия mousemove показывал контролы уже навсегда. Заодно клик мыши
  // в момент t=4.9s перевзводит таймер, а не прячет контролы через 0.1s.
  // 5 секунд бездействия — и на watch-странице, и в полноэкранном режиме;
  // показывают контролы mousemove и касания (pointer-события покрывают оба).
  const hideTimerRef = React.useRef<number | null>(null);
  const clearHideTimer = React.useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);
  const armHideTimer = React.useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, CONTROLS_HIDE_MS);
  }, [clearHideTimer]);

  React.useEffect(() => {
    if (!playing) {
      clearHideTimer();
      setControlsVisible(true);
      return;
    }
    armHideTimer();
    return clearHideTimer;
  }, [playing, armHideTimer, clearHideTimer]);

  React.useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Полноэкранным считаем и нативный Fullscreen API, и наш CSS-фолбэк.
  const fullscreenActive = isFullscreen || cssFullscreen;

  /* ---------- Живое превью при перемотке (стримы без спрайта) ---------- */
  const {
    previewRef: previewVideoRef,
    previewSrc,
    onScrubTime: handleScrubTime,
  } = useScrubPreview(sprites, activeFile);

  // Мемоизация: эти пропсы идут в React.memo(PlayerControls) — без неё
  // свежие массивы/ноды на каждом ререндере сводили мемоизацию на нет.
  const scrubPreview = React.useMemo(
    () =>
      previewSrc ? (
        <video
          ref={previewVideoRef}
          src={previewSrc}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
        />
      ) : null,
    [previewSrc, previewVideoRef],
  );

  const activeCueList = activeCues(cues, currentTime, shiftMs);
  const introVisible = isIntroVisible(currentTime, links.intro);
  const nearEnd = isNearEnd(currentTime, duration) && !!next;
  // Ссылки на потоки приходят относительными (/gst/..., /stream?...): один билд
  // обслуживает и http://<ip>, и https://<имя>. Внешним плеерам и буферу обмена
  // относительный путь бесполезен — там нужен полный адрес.
  const externalStreamUrl = absoluteStreamUrl(streamUrl);
  const cast = useCast(videoRef, { url: externalStreamUrl, title, poster: links.posterUrl });

  // Опции для контролов — стабильные массивы под React.memo.
  const audioTrackOptions = React.useMemo(
    () =>
      audios.map((a, i) => ({
        index: i,
        label: `${a.type.toUpperCase()}${a.author.title ? ` · ${a.author.title}` : ""} (${a.lang})`,
      })),
    [audios],
  );
  const subtitleOptions = React.useMemo(
    () => subtitles.map((s) => ({ index: s.index, label: s.label })),
    [subtitles],
  );
  const qualityOptions = React.useMemo(
    () =>
      links.files.map((f, i) => ({
        index: i,
        // Помечаем уже отброшенные раздачи, чтобы выбор качества не был
        // лотереей: пользователь видит, какие не заиграли, и не тыкает в них.
        label: deadFiles.includes(i) ? `${f.quality} · не заиграла` : f.quality,
      })),
    [links.files, deadFiles],
  );

  return (
    <div
      ref={containerRef}
      className={
        cssFullscreen
          ? "fixed inset-0 z-[100] flex select-none flex-col items-center justify-center overflow-hidden bg-black"
          : "relative w-full select-none overflow-hidden rounded-[var(--radius-card)] bg-black"
      }
      // Pointer-события покрывают и мышь, и палец: любое движение или касание
      // показывает контролы и перевзводит таймер автоскрытия.
      onPointerMove={() => {
        setControlsVisible(true);
        if (playing) armHideTimer();
      }}
      onPointerDown={() => {
        setControlsVisible(true);
        if (playing) armHideTimer();
      }}
      data-testid="player"
    >
      <video
        ref={videoRef}
        className={
          cssFullscreen ? "h-full w-full bg-black object-contain" : "aspect-video w-full bg-black"
        }
        onClick={togglePlay}
        playsInline
        preload="auto"
        autoPlay
        muted={muted}
        poster={links.posterUrl ?? undefined}
        aria-label={title}
        data-testid="player-video"
      />

      {/* Субтитры со сдвигом */}
      <SubtitleOverlay cues={activeCueList} />

      {/* Пропустить интро */}
      {introVisible && <SkipIntroButton endSeconds={links.intro!.endSeconds} onSkip={seek} />}

      {/* Автоплей без звука: политика браузера не дала играть со звуком —
          даём явную кнопку, чтобы не оставить пользователя в тишине. */}
      {soundBlocked && muted && <UnmuteOverlay onUnmute={unmute} />}

      {/* Следующая серия */}
      {nearEnd && (
        <NextEpisodeOverlay
          next={next!}
          onPlay={() => {
            reportProgress();
            // Маршрут /watch/[itemId]/[mediaId]: itemId берём из links, он
            // относится к играющему медиа. router.push — клиентская
            // навигация вместо полной перезагрузки.
            router.push(`/watch/${links.itemId}/${next!.mediaId}`);
          }}
        />
      )}

      {/* Старт источника: этапы вместо пустого спиннера. Перебор раздач
          показывает свой текст — он важнее этапов. */}
      {startPhase !== "done" && !error && !switchingSource && (
        <LoadingStages
          overlay
          stage={startPhase}
          hint={startPhase === "connect" ? "Связываемся с раздачей и пирами…" : "Загружаем начало видео…"}
        />
      )}

      {/* «Не играет / не та серия» — рядом с контролами, пока они видны,
          и всегда на экране ошибки. */}
      {onSourceReported && (controlsVisible || error) && (
        <StreamReportButton
          mediaId={links.mediaId}
          streamUrl={activeFile?.urls.hls ?? activeFile?.urls.http}
          isEpisode={(episodeGroups?.length ?? 0) > 0}
          onReported={onSourceReported}
        />
      )}

      {/* Индикатор буферизации */}
      {isBuffering && !error && (startPhase === "done" || switchingSource) && (
        <BufferingOverlay
          switchingSource={switchingSource}
          deadCount={deadFiles.length}
          totalFiles={links.files.length}
        />
      )}

      {/* Ошибка воспроизведения с кнопками внешних плееров */}
      {error && (
        <PlaybackError error={error} streamUrl={externalStreamUrl} onRetry={retryAllSources} />
      )}

      <div className={controlsVisible ? "block" : "hidden"}>
        {/* Позиция въезжает контекстом: 4Гц-тик timeupdate перерисовывает
            только Seekbar и TimeLabel внутри мемоизированных контролов. */}
        <PlayerTimeContext.Provider value={currentTime}>
          <PlayerControls
            playing={playing}
            duration={duration}
            buffered={buffered}
            volume={volume}
            muted={muted}
            playbackRate={playbackRate}
            speeds={PLAYBACK_SPEEDS}
            shiftMs={shiftMs}
            audioTracks={audioTrackOptions}
            activeAudio={activeAudio}
            subtitles={subtitleOptions}
            activeSubtitle={activeSubtitle}
            qualities={qualityOptions}
            activeQuality={activeFileIndex}
            onQuality={changeQuality}
            episodeGroups={episodeGroups}
            activeEpisode={currentMediaId}
            onEpisode={changeEpisode}
            sprites={sprites}
            spriteUrl={sprites?.url ?? null}
            scrubPreview={scrubPreview}
            onScrubTime={handleScrubTime}
            isFullscreen={fullscreenActive}
            onTogglePlay={togglePlay}
            onSeek={seek}
            onVolume={changeVolume}
            onRate={changeRate}
            onAudio={pickAudio}
            onSubtitle={changeSubtitle}
            onShift={shiftSubtitles}
            onPip={togglePip}
            onFullscreen={toggleFullscreen}
            cast={cast}
          />
        </PlayerTimeContext.Provider>
      </div>
    </div>
  );
}
