"use client";

/**
 * Инициализация источника: hls.js с тюнингом буфера, динамический импорт,
 * лестница деградации (ретраи манифеста → прямой стрим → следующая раздача),
 * восстановление дорожек после смены качества и очистка при размонтировании.
 *
 * Вынесено из Player: эффект на ~160 строк с 14 внешними зависимостями
 * делал компонент нечитаемым. Всё состояние остаётся у Player — хук
 * получает его через параметры, как чистый эффект.
 */
import type HlsJs from "hls.js";
import * as React from "react";
import type { SubtitleTrack } from "./hooks";

export interface StreamSetupParams {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  hlsRef: React.RefObject<HlsJs | null>;
  /** null — источник ещё не выбран: эффект ничего не делает. */
  streamUrl: string | null;
  /** Раздача, с которой играем: её http-урл — фолбэк при смерти gst. */
  activeFile: { urls: { hls: string | null; http: string } } | undefined;
  /** Прямой HTTP-стрим уже пробовали (Safari/TorrServer/MP4). */
  directFallback: boolean;
  /** Ручной триггер «Попробовать снова»: индекс раздачи может не измениться. */
  sourceEpoch: number;
  setError: (message: string | null) => void;
  setIsBuffering: (b: boolean) => void;
  setDirectFallback: (b: boolean) => void;
  setSubtitles: React.Dispatch<React.SetStateAction<SubtitleTrack[]>>;
  gstRetryRef: React.RefObject<number>;
  tryAutoplayRef: React.RefObject<() => void>;
  activeAudioRef: React.RefObject<number>;
  activeSubtitleRef: React.RefObject<number | null>;
  abandonRef: React.RefObject<() => void>;
}

export function useStreamSetup(params: StreamSetupParams): void {
  const {
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
  } = params;

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
    let mediaRecoveries = 0;
    // Таймер gst-ретрая манифеста: живёт вместе со стримом. После hls.destroy()
    // колбэк должен сработать разве что вхолостую — гасим явно, а не надеемся
    // на guard hlsRef.current === hls.
    let gstRetryTimer: number | null = null;

    void (async () => {
      if (isHls && canMse) {
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;
        hls = new Hls({
          enableWorker: true,
          // Буфер: цель — 90 секунд вперёд, потолок — 5 минут, назад минута.
          //
          // Раньше здесь стояло 30/120, а комментарий обещал «вперёд до 2
          // минут» — то есть числа и текст противоречили друг другу, и прав
          // был код. Для торрент-раздачи 30 секунд мало: скорость прихода
          // сегментов плавает вместе с сидами, и короткий буфер выбирается
          // в ноль на каждом провале канала — плеер встаёт на «буферизацию».
          // 90 секунд покрывают такие провалы, а потолок в 5 минут нужен,
          // чтобы на быстром канале hls.js не растягивал буфер бесконечно:
          // это память и лишний трафик вперёд по фильму.
          maxBufferLength: 90,
          maxMaxBufferLength: 300,
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
                gstRetryTimer = window.setTimeout(() => {
                  gstRetryTimer = null;
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
            // Общий лимит ретраев вне манифеста — чтобы не крутить бесконечно на мёртвой сети.
            if ((abandonRef as unknown as { retries?: number }).retries == null) (abandonRef as unknown as { retries: number }).retries = 0;
            if ((abandonRef as unknown as { retries: number }).retries >= 3) {
              setError("Сеть недоступна — попробуйте позже");
              return;
            }
            (abandonRef as unknown as { retries: number }).retries += 1;
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // recoverMediaError без счётчика гонял цикл error→recover→error
            // на безнадёжном стриме. Две попытки — дальше оверлей.
            mediaRecoveries += 1;
            if (mediaRecoveries <= 2) {
              hls.recoverMediaError();
              return;
            }
            setIsBuffering(false);
            setError(`Ошибка декодирования HLS: ${data.details}`);
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
    })().catch((err) => {
      // Сбой динамического импорта hls.js (оффлайн-чанк) и прочие ошибки
      // инициализации раньше уходили в unhandled rejection: тихий чёрный
      // экран вместо оверлея.
      if (cancelled) return;
      setIsBuffering(false);
      setError(`Не удалось запустить плеер: ${String(err).slice(0, 120)}`);
    });

    return () => {
      cancelled = true;
      if (gstRetryTimer !== null) {
        window.clearTimeout(gstRetryTimer);
        gstRetryTimer = null;
      }
      hls?.destroy();
      hlsRef.current = null;
      // Пауза до removeAttribute: часть браузеров доигрывает буфер старого
      // ресурса после смены источника. video.load() без src эмитит
      // MEDIA_ERR и ложно запускает source-abandon, поэтому только pause.
      video.pause();
      video.removeAttribute("src");
    };
  }, [
    // Рефы и сеттеры стабильны по контракту (useRef/useState) — в deps
    // они стоят для полноты, перезапуска эффекта не создают.
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
  ]);
}
