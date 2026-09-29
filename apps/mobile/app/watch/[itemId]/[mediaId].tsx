"use client";

import type { AudioTrack, ItemDetail, MediaLinks, Subtitle } from "@zal/api-client";
import { episodeGroups, flattenEpisodes, PLAYBACK_SPEEDS, pollMediaTracks } from "@zal/shared";
import { tokens } from "@zal/ui";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useLocalSearchParams, useRouter } from "expo-router";
import { type TimeUpdateEventPayload, useVideoPlayer, type VideoSource, VideoView } from "expo-video";
/**
 * Плеер: нативный HLS (expo-video), резюме и синхронизация прогресса,
 * «пропустить интро», следующая серия, скорость, полный экран.
 *
 * Дубляж переключается через персональные мастера (`audios[].masterUrl`):
 * у каждого свой HLS-плейлист (видео-лестница + одна аудио-группа),
 * поэтому нативный плеер без API выбора аудио играет нужный дубляж.
 * Внешние WebVTT-субтитры нативный HLS не принимает — они в веб-плеере.
 */
import * as React from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTvFocus } from "../../../components/tv-focus";
import { useAuth } from "../../../lib/auth";
import { bufferedBand } from "../../../lib/buffer";
import { formatTime } from "../../../lib/format";
import { cueAt, fetchSubtitleCues, type SubtitleCue } from "../../../lib/subtitles";
import { shouldSaveProgress } from "../../../lib/watch-state";
import { styles } from "./[mediaId].styles";

const SAVE_EVERY_SECONDS = 10;
// Тег keep-awake: активация/деактивация ходят парой по одному тегу.
const KEEP_AWAKE_TAG = "zal-watch";

export default function WatchScreen() {
  const { itemId, mediaId } = useLocalSearchParams<{ itemId: string; mediaId: string }>();
  const itemIdNum = Number(itemId);
  const mediaIdNum = Number(mediaId);
  const router = useRouter();
  const { api } = useAuth();

  const [links, setLinks] = React.useState<MediaLinks | null>(null);
  const [item, setItem] = React.useState<ItemDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [activeAudio, setActiveAudio] = React.useState(0);
  // Индекс 1× в общей лестнице PLAYBACK_SPEEDS ([0.5, 0.75, 1, …]) — старт
  // с обычной скорости, сама лестница общая с вебом.
  const [speedIdx, setSpeedIdx] = React.useState(2);
  // Субтитры: внешние WebVTT рисуем оверлеем, сдвиг — в миллисекундах.
  const [cues, setCues] = React.useState<SubtitleCue[]>([]);
  const [activeSub, setActiveSub] = React.useState<number | null>(null);
  const [shiftMs, setShiftMs] = React.useState(0);
  // Дорожка не скачалась: инлайн-сообщение у чипов, дорожка остаётся выключенной.
  const [subError, setSubError] = React.useState<string | null>(null);
  // Обрыв потока: оверлей «Видео оборвалось» поверх замершего кадра.
  const [playbackError, setPlaybackError] = React.useState<string | null>(null);

  // Таймер плеера.
  const [current, setCurrent] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  // Сырое «докуда забуферено», в секундах. Держим именно сырое значение, а
  // долю считает bufferedBand — та же функция, что покрыта тестами, вместо
  // второй копии тех же clamps прямо в разметке.
  const [bufferedPosition, setBufferedPosition] = React.useState(0);
  const [barWidth, setBarWidth] = React.useState(0);
  // На TV (ландшафт 16:9) видео в полную ширину заняло бы весь экран и
  // вытолкнуло контролы за фолд — ограничиваем высоту долей экрана.
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const videoHeight = Math.min((winWidth * 9) / 16, winHeight * 0.72);
  // Фокус для пульта: у плеера нет тача, всё ходит по focusable-контролам.
  const focusSeekBar = useTvFocus();
  const focusSkipIntro = useTvFocus();
  const focusNext = useTvFocus();
  const focusRetry = useTvFocus();
  const focusErrBack = useTvFocus();

  const resumeRef = React.useRef(0);
  const appliedResumeRef = React.useRef(false);
  const lastSaveRef = React.useRef(0);
  // Кэш распарсенных субтитров по индексу дорожки: повторный выбор дорожки
  // не должен гонять второй fetch+parse того же файла.
  const subCacheRef = React.useRef<Map<number, SubtitleCue[]>>(new Map());
  // Последние измеренные значения плеера. Нужны потому, что cleanup на
  // размонтировании выполняется уже после того, как useVideoPlayer освободил
  // игрока (release() зарегистрирован раньше наших эффектов) — читать у него
  // currentTime в этот момент нельзя, объект отвязан от нативного и бросает.
  const positionRef = React.useRef(0);
  const durationRef = React.useRef(0);
  const videoRef = React.useRef<React.ComponentRef<typeof VideoView>>(null);

  const player = useVideoPlayer(null, (p) => {
    p.play();
  });

  // 1. Ссылки + позиция резюме. Смена media (следующая серия) сбрасывает
  // стейт прошлого эпизода: субтитры, аудио, ошибку — иначе реплики
  // предыдущей серии рисуются поверх нового видео.
  React.useEffect(() => {
    let cancelled = false;
    setCues([]);
    setActiveSub(null);
    setActiveAudio(0);
    // Выбор дубляжа — тоже состояние прошлой серии: у новой свой список дорожек.
    setAudioChoice(null);
    setShiftMs(0);
    setError(null);
    setPlaying(false);
    setSubError(null);
    setPlaybackError(null);
    // Кэш субтитров прошлой серии к новой отношения не имеет.
    subCacheRef.current.clear();
    // Буфер прошлой серии к новой отношения не имеет: без сброса серая полоса
    // на мгновение показала бы скачанное из другого файла.
    setBufferedPosition(0);
    appliedResumeRef.current = false;
    // Прошлый эпизод: его позицию здесь держать нельзя. Смена media меняет и
    // mediaIdNum, поэтому запись «на паузе» ниже ушла бы под новую серию с
    // чужими секундами. Длительность 0 закрывает запись до первого тика.
    positionRef.current = 0;
    durationRef.current = 0;
    void (async () => {
      try {
        const [linksRes, progressRes] = await Promise.all([
          api.getMediaLinks(itemIdNum, mediaIdNum),
          api.getProgress(mediaIdNum).catch(() => ({ progress: null })),
        ]);
        if (cancelled) return;
        setLinks(linksRes);
        resumeRef.current = progressRes.progress?.positionSeconds ?? 0;
        lastSaveRef.current = resumeRef.current;
      } catch {
        if (!cancelled) setError("Видео не найдено");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, itemIdNum, mediaIdNum]);

  // 2. Следующая серия (для кнопки) — из карточки тайтла.
  React.useEffect(() => {
    let cancelled = false;
    api.getItem(itemIdNum).then(
      (res) => {
        if (!cancelled) setItem(res);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, itemIdNum]);

  const nextMedia = React.useMemo(() => {
    if (!item) return null;
    // Порядок серий общий с вебом (@zal/shared): сосед в меню и «следующая
    // серия» — один и тот же слот на обоих клиентах.
    const groups = episodeGroups(item);
    const flat = flattenEpisodes(groups);
    const idx = flat.findIndex((e) => e.mediaId === mediaIdNum);
    return idx >= 0 && idx + 1 < flat.length ? flat[idx + 1]!.mediaId : null;
  }, [item, mediaIdNum]);

  /**
   * 3. Ленивые аудио-дорожки: gst-проба на холодных пирах занимает до 45с,
   * поэтому идёт фоном, пока видео уже играет, и подмешивается в links.
   * Лестница таймингов общая с веб-плеером (@zal/shared).
   */
  React.useEffect(() => {
    if (!links || links.audios.length > 0) return;
    return pollMediaTracks(
      () => api.getMediaTracks(links.itemId, links.mediaId),
      (audios) => {
        setLinks((cur) => (cur ? { ...cur, audios } : cur));
      },
    );
  }, [api, links]);

  /** Отправка прогресса: пауза, таймер, размонтирование. */
  const saveProgress = React.useCallback(
    (force = false) => {
      const position = positionRef.current;
      const total = durationRef.current;
      if (
        !shouldSaveProgress({
          position,
          duration: total,
          lastSaved: lastSaveRef.current,
          force,
        })
      ) {
        return;
      }
      lastSaveRef.current = position;
      void api
        .saveProgress(mediaIdNum, {
          positionSeconds: Math.round(position),
          durationSeconds: Math.round(total),
        })
        .catch(() => {});
    },
    [api, mediaIdNum],
  );

  // 3. Источник: главный мастер либо персональный мастер выбранного дубляжа.
  //
  // `audioChoice` — отдельно от `activeAudio` намеренно, и это не украшение.
  // `activeAudio` — подсветка в списке, и по умолчанию там 0. Дорожки приезжают
  // лениво, через несколько секунд после старта (gst-проба на холодных пирах
  // идёт до 45 с), поэтому «в списке отмечен нулевой» и «пользователь выбрал
  // нулевой» — разные состояния, и первое наступает само. Пока они были одним
  // стейтом, `sourceUri` в момент прихода дорожек менялся с общего мастера на
  // персональный мастер нулевого дубляжа — прямо во время просмотра, — и
  // эффект ниже перезагружал ассет вторым `replace()`: картинка рвалась на
  // ровном месте, а на iOS replace() ещё и грузит ассет синхронно, то есть
  // это был двойной фриз. Теперь источник меняет только явный выбор.
  const [audioChoice, setAudioChoice] = React.useState<number | null>(null);

  const sourceUri = React.useMemo(() => {
    if (!links) return null;
    const chosen = audioChoice == null ? null : links.audios[audioChoice];
    return chosen?.masterUrl ?? links.files.find((f) => f.urls.hls)?.urls.hls ?? null;
  }, [links, audioChoice]);

  const loadSource = React.useCallback(
    (uri: string, resumeAt: number) => {
      appliedResumeRef.current = false;
      resumeRef.current = resumeAt;
      const source: VideoSource = { uri };
      player.replace(source);
      player.play();
    },
    [player],
  );

  React.useEffect(() => {
    if (sourceUri) loadSource(sourceUri, resumeRef.current);
  }, [sourceUri, loadSource]);

  /**
   * Повтор после обрыва: replace того же источника, сохранив позицию.
   * loadSource зовём прямо из кнопки: sourceUri при этом не меняется, и
   * эффект выше не делает второй replace (в отличие от смены дубляжа).
   */
  const retryPlayback = React.useCallback(() => {
    if (!sourceUri) return;
    const at = positionRef.current;
    lastSaveRef.current = at;
    setPlaybackError(null);
    loadSource(sourceUri, at);
  }, [sourceUri, loadSource]);

  // 4. Тик плеера: позиция/длительность + резюме + автосохранение.
  //
  // Раньше здесь стоял собственный setInterval на 250 мс, который сам вычитывал
  // player.currentTime, player.duration и player.playing. Опрос — это три
  // пересечения моста JS↔нативный плеер четыре раза в секунду, причём с той же
  // частотой и на паузе, и в фоне, где ничего не меняется. expo-video отдаёт то
  // же самое событием, а `playingChange` избавляет от чтения player.playing.
  React.useEffect(() => {
    // Шаг тот же, что был у опроса: чаще незачем — полоса времени дёргается.
    player.timeUpdateEventInterval = 0.25;

    const onTime = ({ currentTime, bufferedPosition: buffered }: TimeUpdateEventPayload) => {
      const position = currentTime;
      const total = Number.isFinite(player.duration) ? player.duration : 0;
      positionRef.current = position;
      durationRef.current = total;
      setCurrent(position);
      setDuration(total);
      // Буфер приходит в том же событии, что и позиция: отдельного похода через
      // мост за player.bufferedPosition не нужно (см. комментарий выше про
      // опрос). Проверять значение здесь нечем — этим занят bufferedBand.
      setBufferedPosition(buffered);

      // Резюме уже применено — значит «точка возобновления» дальше просто равна
      // текущей позиции. Без этого она навсегда оставалась стартовой, и любая
      // смена источника уводила плеер назад: loadSource берёт resumeRef, а его
      // меняли только на входе. Смена источника случается не только по кнопке
      // дубляжа — фоновые аудио-дорожки подмешиваются сами через 4 секунды
      // после старта, и позиция сбрасывалась прямо во время просмотра.
      const resumeApplied = appliedResumeRef.current;
      if (resumeApplied) resumeRef.current = position;

      if (!resumeApplied && total > 0) {
        appliedResumeRef.current = true;
        if (resumeRef.current > 0 && resumeRef.current < total - 5) {
          player.currentTime = resumeRef.current;
          lastSaveRef.current = resumeRef.current;
        }
      }
      if (player.playing && position - lastSaveRef.current >= SAVE_EVERY_SECONDS) {
        saveProgress();
      }
    };

    const timeSub = player.addListener("timeUpdate", onTime);
    const playSub = player.addListener("playingChange", ({ isPlaying }) => {
      setPlaying(isPlaying);
    });
    // Один явный снимок на входе: если воспроизведение уже шло до того, как
    // слушатель подключился, перехода play/pause больше не будет, и кнопка
    // осталась бы в состоянии «пауза» до первого нажатия.
    setPlaying(player.playing);

    return () => {
      timeSub.remove();
      playSub.remove();
      player.timeUpdateEventInterval = 0;
    };
  }, [player, saveProgress]);

  // 4b. Ошибки плеера. expo-video не имеет отдельного события ошибок —
  // единственный канал это `statusChange`: статус становится "error", а в
  // payload приезжает необязательный error с сообщением. Без подписки обрыв
  // HLS посреди серии выглядит как замерший кадр: плеер молча останавливается.
  React.useEffect(() => {
    const sub = player.addListener("statusChange", ({ status, error: playerError }) => {
      if (status === "error") {
        // freeze.playing может ещё стоять true — гасим, чтобы кнопка не
        // показывала «Пауза» над мёртвым потоком.
        setPlaying(false);
        setPlaybackError(playerError?.message ?? "Видео оборвалось");
        return;
      }
      // Любой уход из error (replace → loading) снимает оверлей.
      setPlaybackError(null);
    });
    return () => {
      sub.remove();
    };
  }, [player]);

  // 5. Прогресс на паузе и при уходе с экрана.
  React.useEffect(() => {
    if (!playing) saveProgress(true);
  }, [playing, saveProgress]);

  React.useEffect(
    () => () => {
      saveProgress(true);
    },
    [saveProgress],
  );

  // 5b. Экран не гаснет, только пока идёт воспроизведение: пауза снимает
  // удержание. useKeepAwake в expo-keep-awake не умеет active-флаг, поэтому
  // activate/deactivate в эффекте по `playing`.
  React.useEffect(() => {
    if (!playing) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [playing]);

  // 5c. Уход в фон: фиксируем прогресс и ставим паузу. По умолчанию плеер и
  // так останавливается (staysActiveInBackground = false), но прогресс без
  // явной записи терял бы последние секунды до таймера автосохранения.
  React.useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "background") return;
      saveProgress(true);
      player.pause();
    });
    return () => {
      sub.remove();
    };
  }, [player, saveProgress]);

  /** Перемотка: позицию держим и в ref — тик обновит его только через 250 мс. */
  const seekTo = (seconds: number) => {
    const clamped = Math.max(0, Math.min(seconds, duration || Infinity));
    player.currentTime = clamped;
    positionRef.current = clamped;
    setCurrent(clamped);
  };

  const seekBy = (delta: number) => {
    seekTo(player.currentTime + delta);
  };

  const changeSpeed = () => {
    const next = (speedIdx + 1) % PLAYBACK_SPEEDS.length;
    setSpeedIdx(next);
    player.playbackRate = PLAYBACK_SPEEDS[next]!;
  };

  /**
   * Субтитры: повторный клик по дорожке выключает её. Распарсенные cues
   * кэшируются по индексу дорожки — повторный выбор уже скачанной дорожки
   * не ходит в сеть. Сбой загрузки не молчит: инлайн-сообщение, дорожка
   * остаётся явно выключенной (и не кэшируется, чтобы «Повторить»
   * действительно ходил в сеть).
   */
  const selectSubtitle = React.useCallback(
    async (index: number) => {
      setSubError(null);
      if (activeSub === index) {
        setActiveSub(null);
        setCues([]);
        return;
      }
      const sub = links?.subtitles[index];
      if (!sub?.url) return;
      const cached = subCacheRef.current.get(index);
      if (cached) {
        setCues(cached);
        setShiftMs(sub.shiftMs ?? 0);
        setActiveSub(index);
        return;
      }
      try {
        const parsed = await fetchSubtitleCues(sub.url);
        subCacheRef.current.set(index, parsed);
        setCues(parsed);
        setShiftMs(sub.shiftMs ?? 0);
        setActiveSub(index);
      } catch {
        setCues([]);
        setActiveSub(null);
        setSubError("Дорожка не загрузилась");
      }
    },
    [links, activeSub],
  );

  const activeCue = React.useMemo(
    () => (cues.length ? cueAt(cues, current, shiftMs) : null),
    [cues, current, shiftMs],
  );

  /** Дубляж: источник меняет эффект ниже — здесь только запоминаем позицию. */
  const changeAudio = (index: number) => {
    const dub = links?.audios[index];
    // Сравниваем с выбором, а не с подсветкой: выбор нулевого дубляжа при
    // `activeAudio === 0` раньше считался повтором и не делал ничего, хотя
    // играл общий мастер, а не персональный мастер этого дубляжа.
    if (!dub?.masterUrl || index === audioChoice) return;
    // Позицию фиксируем до смены источника: replace() обнуляет currentTime.
    resumeRef.current = player.currentTime;
    // loadSource отсюда звать нельзя: setAudioChoice вызовет перерисовку,
    // sourceUri изменится, и эффект ниже перезагрузит тот же ассет вторым
    // replace(). На iOS replace() грузит ассет синхронно на главном потоке —
    // то есть это ещё и двойной фриз на переключении дубляжа.
    setAudioChoice(index);
    setActiveAudio(index);
  };

  /**
   * Серая полоса «уже скачано впереди». Пересчитывается от текущей позиции:
   * отрезок живёт между позицией и `bufferedPosition`, поэтому обновляется он
   * вместе с ними, а не по своему таймеру.
   */
  const buffered = React.useMemo(
    () => bufferedBand(current, bufferedPosition, duration),
    [current, bufferedPosition, duration],
  );

  const intro = links?.intro;
  const inIntro =
    intro != null && current >= intro.startSeconds && current < intro.endSeconds;

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>{error}</Text>
      </View>
    );
  }

  return (
    <SafeAreaView testID="player-screen" style={styles.container} edges={["top", "left", "right"]}>
      <View style={[styles.videoWrap, { height: videoHeight }]}>
        <VideoView
          ref={videoRef}
          player={player}
          style={styles.video}
          contentFit="contain"
          nativeControls={false}
        />
        {activeCue && (
          <View testID="player-subtitle-overlay" style={styles.subtitleOverlay} pointerEvents="none">
            <Text style={styles.subtitleText}>{activeCue.text}</Text>
          </View>
        )}
        {playbackError && (
          <View testID="player-error" style={styles.errorOverlay}>
            <Text style={styles.errorTitle}>Видео оборвалось</Text>
            <View style={styles.errorButtons}>
              <Pressable
                testID="player-retry"
                style={[styles.playButton, focusRetry.ring]}
                onPress={retryPlayback}
                accessibilityRole="button"
                hasTVPreferredFocus
                {...focusRetry.props}
              >
                <Text style={styles.playText}>Повторить</Text>
              </Pressable>
              <Pressable
                testID="player-error-back"
                style={[styles.controlButton, focusErrBack.ring]}
                onPress={() => router.back()}
                accessibilityRole="button"
                {...focusErrBack.props}
              >
                <Text style={styles.controlText}>Назад</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {!links && (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.color.accent} />
        </View>
      )}

      <ScrollView style={styles.controls} contentContainerStyle={styles.controlsContent}>
        <View style={styles.timeRow}>
          <Text testID="player-current-time" style={styles.time}>
            {formatTime(current)}
          </Text>
          <Pressable
            testID="player-seekbar"
            style={[styles.seekbar, focusSeekBar.ring]}
            {...focusSeekBar.props}
            onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
            onPress={(e) => {
              if (!duration || barWidth <= 0) return;
              const ratio = Math.max(0, Math.min(1, e.nativeEvent.locationX / barWidth));
              seekTo(ratio * duration);
            }}
            accessibilityRole="button"
          >
            {/* Полоса буфера идёт первой: в RN следующий ребёнок рисуется поверх
                предыдущего, поэтому заливка проигранного ложится на серое, а не
                наоборот. Отрезок начинается от текущей позиции — см. buffer.ts. */}
            {buffered && (
              <View
                testID="player-buffered"
                pointerEvents="none"
                style={[
                  styles.seekBuffered,
                  {
                    left: `${buffered.start * 100}%`,
                    width: `${(buffered.end - buffered.start) * 100}%`,
                  },
                ]}
              />
            )}
            <View
              testID="player-seek-fill"
              style={[
                styles.seekFill,
                { width: duration ? `${(current / duration) * 100}%` : "0%" },
              ]}
            />
          </Pressable>
          <Text testID="player-duration" style={styles.time}>
            {formatTime(duration)}
          </Text>
        </View>

        <ControlsRow
          playing={playing}
          speed={PLAYBACK_SPEEDS[speedIdx]}
          onTogglePlay={() => (player.playing ? player.pause() : player.play())}
          onSeekBy={seekBy}
          onChangeSpeed={changeSpeed}
          onEnterFullscreen={() => void videoRef.current?.enterFullscreen()}
        />

        {inIntro && intro && (
          <Pressable
            testID="player-skip-intro"
            style={[styles.introButton, focusSkipIntro.ring]}
            onPress={() => {
              seekTo(intro.endSeconds);
            }}
            accessibilityRole="button"
            {...focusSkipIntro.props}
          >
            <Text style={styles.playText}>Пропустить интро</Text>
          </Pressable>
        )}

        {nextMedia && (
          <Pressable
            testID="player-next"
            style={[styles.nextButton, focusNext.ring]}
            // replace: стек не должен расти с каждой серией — back уводит
            // из плеера, а не листает все просмотренные эпизоды.
            // Прогресс фиксируем до ухода: смена mediaId сбросит ref-позицию,
            // и последние секунды текущей серии ушли бы под следующую.
            onPress={() => {
              saveProgress(true);
              router.replace(`/watch/${itemIdNum}/${nextMedia}`);
            }}
            accessibilityRole="button"
            {...focusNext.props}
          >
            <Text style={styles.controlText}>Следующая серия →</Text>
          </Pressable>
        )}

        {links && links.subtitles.length > 0 && (
          <SubtitlesSection
            subtitles={links.subtitles}
            activeSub={activeSub}
            subError={subError}
            shiftMs={shiftMs}
            onSelect={(i) => void selectSubtitle(i)}
            onShift={(d) => setShiftMs((v) => v + d)}
          />
        )}

        {links && links.audios.length > 1 && (
          <DubbingSection audios={links.audios} activeAudio={activeAudio} onChoose={changeAudio} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Чип дорожки (дубляж/субтитры) — отдельный компонент ради фокуса пульта. */
function TrackChip({
  testID,
  label,
  active,
  disabled,
  onPress,
}: {
  testID: string;
  label: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const focus = useTvFocus();
  return (
    <Pressable
      testID={testID}
      style={[
        styles.controlButton,
        active && styles.controlActive,
        disabled && styles.controlOff,
        focus.ring,
      ]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      aria-selected={active}
      {...focus.props}
    >
      <Text style={styles.controlText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Ряд управления плеером: перемотка, пауза, скорость, полный экран.
 * Выделен ради читаемости экрана; фокус-хуки пульта живут здесь же.
 */
function ControlsRow({
  playing,
  speed,
  onTogglePlay,
  onSeekBy,
  onChangeSpeed,
  onEnterFullscreen,
}: {
  playing: boolean;
  speed: number;
  onTogglePlay: () => void;
  onSeekBy: (delta: number) => void;
  onChangeSpeed: () => void;
  onEnterFullscreen: () => void;
}) {
  const focusPlay = useTvFocus();
  const focusControls = [useTvFocus(), useTvFocus(), useTvFocus(), useTvFocus()];
  return (
    <View style={styles.buttonRow}>
      <Pressable
        style={[styles.controlButton, focusControls[0]!.ring]}
        onPress={() => onSeekBy(-10)}
        accessibilityRole="button"
        {...focusControls[0]!.props}
      >
        <Text style={styles.controlText}>−10с</Text>
      </Pressable>
      <Pressable
        testID="player-play"
        style={[styles.playButton, focusPlay.ring]}
        onPress={onTogglePlay}
        accessibilityRole="button"
        hasTVPreferredFocus
        {...focusPlay.props}
      >
        <Text style={styles.playText}>{playing ? "Пауза" : "Играть"}</Text>
      </Pressable>
      <Pressable
        style={[styles.controlButton, focusControls[1]!.ring]}
        onPress={() => onSeekBy(10)}
        accessibilityRole="button"
        {...focusControls[1]!.props}
      >
        <Text style={styles.controlText}>+10с</Text>
      </Pressable>
      <Pressable
        testID="player-speed"
        style={[styles.controlButton, focusControls[2]!.ring]}
        onPress={onChangeSpeed}
        accessibilityRole="button"
        {...focusControls[2]!.props}
      >
        <Text style={styles.controlText}>{speed}×</Text>
      </Pressable>
      <Pressable
        style={[styles.controlButton, focusControls[3]!.ring]}
        onPress={onEnterFullscreen}
        accessibilityRole="button"
        {...focusControls[3]!.props}
      >
        <Text style={styles.controlText}>На весь</Text>
      </Pressable>
    </View>
  );
}

/**
 * Секция субтитров: чипы дорожек, «Выкл», инлайн-ошибка загрузки и сдвиг
 * синхронизации по 0.1с. Загрузкой дорожек и кэшем владеет экран — здесь
 * только разметка.
 */
function SubtitlesSection({
  subtitles,
  activeSub,
  subError,
  shiftMs,
  onSelect,
  onShift,
}: {
  subtitles: Subtitle[];
  activeSub: number | null;
  subError: string | null;
  shiftMs: number;
  onSelect: (index: number) => void;
  onShift: (deltaMs: number) => void;
}) {
  const focusSubOff = useTvFocus();
  const focusShiftBack = useTvFocus();
  const focusShiftFwd = useTvFocus();
  return (
    <View style={styles.dubSection}>
      <Text style={styles.sectionTitle}>Субтитры</Text>
      <View style={styles.buttonRow}>
        {subtitles.map((s, i) => (
          <TrackChip
            key={s.id}
            testID={`player-subtitle-${i}`}
            label={s.title ?? s.lang.toUpperCase()}
            active={i === activeSub}
            disabled={!s.url}
            onPress={() => onSelect(i)}
          />
        ))}
        {activeSub != null && (
          <Pressable
            style={[styles.controlButton, focusSubOff.ring]}
            onPress={() => onSelect(activeSub)}
            accessibilityRole="button"
            {...focusSubOff.props}
          >
            <Text style={styles.controlText}>Выкл</Text>
          </Pressable>
        )}
      </View>
      {subError && (
        <Text testID="player-sub-error" style={styles.muted}>
          {subError}
        </Text>
      )}
      {activeSub != null && (
        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.controlButton, focusShiftBack.ring]}
            onPress={() => onShift(-100)}
            accessibilityRole="button"
            {...focusShiftBack.props}
          >
            <Text style={styles.controlText}>−0.1с</Text>
          </Pressable>
          <Text style={styles.muted}>
            сдвиг {shiftMs > 0 ? "+" : ""}
            {(shiftMs / 1000).toFixed(1)}с
          </Text>
          <Pressable
            style={[styles.controlButton, focusShiftFwd.ring]}
            onPress={() => onShift(100)}
            accessibilityRole="button"
            {...focusShiftFwd.props}
          >
            <Text style={styles.controlText}>+0.1с</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** Секция дубляжа: чипы персональных мастеров дорожек. */
function DubbingSection({
  audios,
  activeAudio,
  onChoose,
}: {
  audios: AudioTrack[];
  activeAudio: number;
  onChoose: (index: number) => void;
}) {
  return (
    <View style={styles.dubSection}>
      <Text style={styles.sectionTitle}>Дубляж</Text>
      <View style={styles.buttonRow}>
        {audios.map((a, i) => (
          <TrackChip
            key={a.id}
            testID={`player-audio-${i}`}
            label={a.author.shortTitle ?? a.author.title ?? `${a.type} (${a.lang})`}
            active={i === activeAudio}
            disabled={!a.masterUrl}
            onPress={() => onChoose(i)}
          />
        ))}
      </View>
    </View>
  );
}
