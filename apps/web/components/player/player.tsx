"use client";

import type { AudioTrack, MediaLinks, SpriteMetaDto } from "@zal/api-client";
import type HlsJs from "hls.js";
import { Volume2 } from "lucide-react";
import { useRouter } from "next/navigation";
/**
 * Плеер «Зал»: hls.js + собственный UI. Аудиодорожки, субтитры со сдвигом,
 * резюме просмотра, пропуск интро, автоследующая серия, хоткеи, PiP.
 * hls.js грузится динамически: браузеры с нативным HLS не тянут ~150КБ в чанк.
 */
import * as React from "react";
import { useAuth } from "@/lib/auth";
import {
  absoluteStreamUrl,
  activeCues,
  isIntroVisible,
  isNearEnd,
  nextAliveSource,
  nextEpisode,
  type PlayerEpisodeGroup,
  parseVtt,
  type SubtitleCue as VttCue,
} from "@/lib/player-logic";
import { PlayerControls } from "./controls";

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

export function Player({
  links,
  title,
  episodeGroups,
  currentMediaId,
  onPlaybackStart,
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
  const [subtitles, setSubtitles] = React.useState<SubtitleTrack[]>([]);
  const [cues, setCues] = React.useState<VttCue[]>([]);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [controlsVisible, setControlsVisible] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [isBuffering, setIsBuffering] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [activeFileIndex, setActiveFileIndex] = React.useState(0);
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

  const activeFile = links.files[activeFileIndex] ?? links.files[0];
  // Дубляж zero-storage: каждая дорожка — персональный HLS-мастер
  // (gst выбирает аудио параметром URL), переключаемся сменой источника.
  // Дорожки приходят лениво (media-tracks) — до них играем базовым мастером.
  const audios = lazyAudios.length > 0 ? lazyAudios : links.audios;
  const audioMaster = activeAudio > 0 ? audios[activeAudio]?.masterUrl : null;
  const baseStream = activeFile?.urls.hls ?? activeFile?.urls.http ?? null;
  const streamUrl = directFallback
    ? (activeFile?.urls.http ?? baseStream)
    : (audioMaster ?? baseStream);
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
    let cancelled = false;
    let attempt = 0;
    let timer = 0;

    const load = () => {
      void (async () => {
        try {
          const res = await api.getMediaTracks(links.itemId, links.mediaId);
          if (cancelled) return;
          if (res.audios.length > 0) {
            setLazyAudios(res.audios);
            return;
          }
        } catch {
          // Фоновая дорожка: сбой не должен дёргать уже играющий плеер.
        }
        // Прогрев ещё едет — пробуем ещё пару раз, потом сдаёмся.
        if (!cancelled && attempt < 2) {
          attempt += 1;
          timer = window.setTimeout(load, 8_000);
        }
      })();
    };

    // Ставим после старта воспроизведения: gst-проба читает ту же голову
    // файла, что и первый сегмент, и не должна с ним конкурировать.
    timer = window.setTimeout(load, 4_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
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

  const tryAutoplay = React.useCallback(() => {
    const video = videoRef.current;
    if (!video || autoplayForMedia.current === links.mediaId) return;
    // Авторизованный ждёт, пока позиция будет применена (или запрос упадёт).
    if (isAuthed && resumeSettled.current !== links.mediaId) return;
    autoplayForMedia.current = links.mediaId;
    void video.play().then(
      () => setSoundBlocked(false),
      (err: unknown) => {
        // NotAllowedError — политика автоплея со звуком. Один раз пробуем без
        // звука и даём кнопку включения; прочие сбои не наш случай.
        const name = err instanceof Error ? err.name : "";
        if (name !== "NotAllowedError") return;
        video.muted = true;
        setMuted(true);
        void video.play().then(
          () => setSoundBlocked(true),
          () => {},
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
    setActiveFileIndex(0);
    setSourceEpoch((n) => n + 1);
  }, []);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    // sourceEpoch — ручной триггер «Попробовать снова»: индекс раздачи при этом
    // может не измениться, поэтому эффект слушает и его. Читаем явно, иначе
    // линтер считает зависимость лишней.
    void sourceEpoch;

    setError(null);
    setIsBuffering(true);
    gstRetryRef.current = 0;

    const isHls = !directFallback && (streamUrl.includes(".m3u8") || Boolean(activeFile?.urls.hls));
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
          // Оптимистичная стартовая оценка канала (4 Мбит/с) — иначе ABR
          // после старта держит 480p и повышает качество медленно.
          abrEwmaDefaultEstimate: 4_000_000,
          // Старт без зонда канала: тянем первый фрагмент сразу, а не ждём
          // замера скорости — на торрент-стриме это экономит секунды.
          startFragPrefetch: true,
          testBandwidth: false,
        });
        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsBuffering(false);
          // Манифест готов — можно играть (резюме доведёт позицию после ответа API).
          tryAutoplayRef.current();
          // После смены качества дорожка сбрасывается на дефолтную —
          // восстанавливаем выбранную пользователем.
          if (hls && hls.audioTracks.length > 1 && activeAudioRef.current > 0) {
            hls.audioTrack = activeAudioRef.current;
          }
          // Встроенные субтитры gst-HLS: треков с прямыми VTT-урлами нет,
          // подменяем список дорожек манифеста и включаем выбранную.
          if (hls && hls.subtitleTracks.length > 0) {
            setSubtitles((cur) => {
              if (cur.some((t) => t.url != null)) return cur;
              return hls!.subtitleTracks.map((t, i) => ({
                index: i,
                label: t.name || t.lang?.toUpperCase() || `Трек ${i + 1}`,
                url: null,
                cues: [],
              }));
            });
            if (activeSubtitleRef.current != null && hls.subtitleTracks[activeSubtitleRef.current]) {
              hls.subtitleTrack = activeSubtitleRef.current;
            }
          }
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal || !hls) return;
          // Транзиентные сбои — норма для торрента-стрима: один блып не должен
          // вешать плеер до перезагрузки страницы.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // Манифест недоступен (gst-транскодер не успел прогреть торрент) —
            // даём ему пару ретраев с паузой, потом падаем на прямой стрим.
            const manifestGone =
              data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
              data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
              data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
            if (manifestGone) {
              gstRetryRef.current += 1;
              if (gstRetryRef.current <= 2) {
                setIsBuffering(true);
                // Первый ретрай скоро (тёплый торрент уже есть в кэше),
                // второй позже — холодным пиром нужно время на подключение.
                const delay = gstRetryRef.current === 1 ? 2_000 : 4_000;
                window.setTimeout(() => {
                  if (hls && hlsRef.current === hls) hls.loadSource(streamUrl);
                }, delay);
                return;
              }
              if (!directFallback && activeFile?.urls.http) {
                setDirectFallback(true);
                return;
              }
              // gst не собрал манифест и прямого стрима нет либо он уже не
              // сработал — раздача мёртвая, берём следующую. Раньше здесь был
              // hls.startLoad(), то есть бесконечный перезаход в тот же URL.
              abandonRef.current();
              return;
            }
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
      tryAutoplayRef.current();
    })();

    return () => {
      cancelled = true;
      hls?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
    };
  }, [streamUrl, activeFile, directFallback, sourceEpoch]);

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
      // Прямой HTTP-стрим узнаёт о готовности только здесь — пробуем play.
      tryAutoplayRef.current();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onPlaying = () => {
      setIsBuffering(false);
      setError(null);
      // Раздача заиграла — перебор закончен, убираем плашку «пробуем другую».
      setSwitchingSource(false);
      if (!playbackStartNotified.current) {
        playbackStartNotified.current = true;
        onPlaybackStartRef.current?.();
      }
    };
    const onWaiting = () => setIsBuffering(true);
    const onCanPlay = () => setIsBuffering(false);
    const onError = () => {
      setIsBuffering(false);
      const err = video.error;
      if (!err) return;

      // Код 2 — сетевой сбой, он бывает транзиентным: одна повторная попытка
      // на раздачу. Коды 3 и 4 — декодер и «источник не поддерживается»:
      // этот файл не заиграет никогда, ждать нечего.
      if (err.code === 2 && gstRetryRef.current < 1) {
        gstRetryRef.current += 1;
        setIsBuffering(true);
        window.setTimeout(() => {
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
    // Per-media: при клиентской навигации на следующую серию плеер может
    // пережить смену источника и обязан заново применить резюме.
    if (!video || !isAuthed || resumeDone.current === links.mediaId) return;
    resumeDone.current = links.mediaId;
    // Гость резюме не ждёт — снимаем «стоп» с автоплея сразу.
    resumeSettled.current = links.mediaId;
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

  /** Смена источника (качество/дубляж) с восстановлением позиции. */
  const swapStream = React.useCallback((mutate: () => void) => {
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
  }, []);

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

  const changeSubtitle = React.useCallback(
    (index: number | null) => {
      // Встроенные субтитры gst-HLS — треки манифеста, рендерит hls.js.
      const hls = hlsRef.current;
      if (hls && hls.subtitleTracks.length > 0 && subtitles[index ?? 0]?.url == null) {
        hls.subtitleTrack = index ?? -1;
      }
      setActiveSubtitle(index);
      setCues(index == null ? [] : (subtitles[index]?.cues ?? []));
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
  // Ссылки на потоки приходят относительными (/gst/..., /stream?...): один билд
  // обслуживает и http://<ip>, и https://<имя>. Внешним плеерам и буферу обмена
  // относительный путь бесполезен — там нужен полный адрес.
  const externalStreamUrl = absoluteStreamUrl(streamUrl);

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
        poster={links.posterUrl ?? undefined}
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

      {/* Автоплей без звука: политика браузера не дала играть со звуком —
          даём явную кнопку, чтобы не оставить пользователя в тишине. */}
      {soundBlocked && muted && (
        <button
          type="button"
          onClick={unmute}
          className="absolute right-4 top-4 inline-flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-sm font-semibold text-black transition hover:bg-white"
          data-testid="unmute-overlay"
        >
          <Volume2 className="h-4 w-4" />
          Включить звук
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
              // Маршрут /watch/[itemId]/[mediaId]: itemId берём из links, он
              // относится к играющему медиа. router.push — клиентская
              // навигация вместо полной перезагрузки.
              router.push(`/watch/${links.itemId}/${next!.mediaId}`);
            }}
          >
            {next!.label}
          </button>
        </div>
      )}

      {/* Индикатор буферизации */}
      {isBuffering && !error && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/40 text-white"
          data-testid="player-buffering"
        >
          <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <p className="text-sm font-medium text-white/90">
            {switchingSource
              ? `Раздача не заиграла — пробуем следующую (${deadFiles.length + 1} из ${links.files.length})…`
              : "Буферизация потока / поиск пиров в сети..."}
          </p>
        </div>
      )}

      {/* Ошибка воспроизведения с кнопками внешних плееров */}
      {error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/90 p-6 text-center text-white">
          <div className="max-w-md">
            <h3 className="mb-2 text-base font-semibold text-white">
              Не удалось воспроизвести в браузере
            </h3>
            <p className="mb-5 text-sm text-muted">{error}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={retryAllSources}
                className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover"
                data-testid="player-retry"
              >
                Попробовать снова
              </button>
              {externalStreamUrl && (
                <>
                  <a
                    href={`iina://weblink?url=${encodeURIComponent(externalStreamUrl)}`}
                    className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover"
                  >
                    Открыть в IINA (Mac)
                  </a>
                  <a
                    href={`vlc://${externalStreamUrl}`}
                    className="rounded-full border border-border bg-surface-elevated px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
                  >
                    Открыть в VLC
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(externalStreamUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
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
          audioTracks={audios.map((a, i) => ({
            index: i,
            label: `${a.type.toUpperCase()}${a.author.title ? ` · ${a.author.title}` : ""} (${a.lang})`,
          }))}
          activeAudio={activeAudio}
          subtitles={subtitles.map((s) => ({ index: s.index, label: s.label }))}
          activeSubtitle={activeSubtitle}
          qualities={links.files.map((f, i) => ({
            index: i,
            // Помечаем уже отброшенные раздачи, чтобы выбор качества не был
            // лотереей: пользователь видит, какие не заиграли, и не тыкает в них.
            label: deadFiles.includes(i) ? `${f.quality} · не заиграла` : f.quality,
          }))}
          activeQuality={activeFileIndex}
          onQuality={changeQuality}
          episodeGroups={episodeGroups}
          activeEpisode={currentMediaId}
          onEpisode={changeEpisode}
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
