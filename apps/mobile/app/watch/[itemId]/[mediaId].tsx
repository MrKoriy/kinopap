"use client";

import type { ItemDetail, MediaLinks } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useVideoPlayer, type VideoSource, VideoView } from "expo-video";
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
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTvFocus } from "../../../components/tv-focus";
import { useAuth } from "../../../lib/auth";
import { formatTime } from "../../../lib/format";
import { cueAt, parseVtt, type SubtitleCue } from "../../../lib/subtitles";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const SAVE_EVERY_SECONDS = 10;

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
  const [speedIdx, setSpeedIdx] = React.useState(1);
  // Субтитры: внешние WebVTT рисуем оверлеем, сдвиг — в миллисекундах.
  const [cues, setCues] = React.useState<SubtitleCue[]>([]);
  const [activeSub, setActiveSub] = React.useState<number | null>(null);
  const [shiftMs, setShiftMs] = React.useState(0);

  // Таймер плеера.
  const [current, setCurrent] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [barWidth, setBarWidth] = React.useState(0);
  // На TV (ландшафт 16:9) видео в полную ширину заняло бы весь экран и
  // вытолкнуло контролы за фолд — ограничиваем высоту долей экрана.
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const videoHeight = Math.min((winWidth * 9) / 16, winHeight * 0.72);
  // Фокус для пульта: у плеера нет тача, всё ходит по focusable-контролам.
  const focusPlay = useTvFocus();
  const focusSeekBar = useTvFocus();
  const focusControls = [
    useTvFocus(),
    useTvFocus(),
    useTvFocus(),
    useTvFocus(),
  ];
  const focusSkipIntro = useTvFocus();
  const focusNext = useTvFocus();
  const focusSubOff = useTvFocus();
  const focusShiftBack = useTvFocus();
  const focusShiftFwd = useTvFocus();

  const resumeRef = React.useRef(0);
  const appliedResumeRef = React.useRef(false);
  const lastSaveRef = React.useRef(0);
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
    setShiftMs(0);
    setError(null);
    setPlaying(false);
    appliedResumeRef.current = false;
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
    const ordered: number[] = [];
    for (const season of item.seasons ?? []) {
      for (const ep of season.episodes) {
        if (ep.mediaId) ordered.push(ep.mediaId);
      }
    }
    for (const part of item.media ?? []) ordered.push(part.id);
    const idx = ordered.indexOf(mediaIdNum);
    return idx >= 0 && idx + 1 < ordered.length ? ordered[idx + 1]! : null;
  }, [item, mediaIdNum]);

  /**
   * 3. Ленивые аудио-дорожки: gst-проба на холодных пирах занимает до 45с,
   * поэтому идёт фоном, пока видео уже играет, и подмешивается в links.
   */
  React.useEffect(() => {
    if (!links || links.audios.length > 0) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = () => {
      void (async () => {
        try {
          const res = await api.getMediaTracks(links.itemId, links.mediaId);
          if (cancelled) return;
          if (res.audios.length > 0) {
            setLinks((cur) => (cur ? { ...cur, audios: res.audios } : cur));
            return;
          }
        } catch {
          // Фоновая дорожка: сбой не должен дёргать играющий плеер.
        }
        if (!cancelled && attempt < 2) {
          attempt += 1;
          timer = setTimeout(load, 8_000);
        }
      })();
    };

    timer = setTimeout(load, 4_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, links]);

  /** Отправка прогресса: пауза, таймер, размонтирование. */
  const saveProgress = React.useCallback(
    (force = false) => {
      const position = player.currentTime;
      const total = Number.isFinite(player.duration) ? player.duration : 0;
      if (!force && position < 5) return;
      if (Math.abs(position - lastSaveRef.current) < 2 && !force) return;
      lastSaveRef.current = position;
      void api
        .saveProgress(mediaIdNum, {
          positionSeconds: Math.round(position),
          durationSeconds: Math.round(total),
        })
        .catch(() => {});
    },
    [api, mediaIdNum, player],
  );

  // 3. Источник: главный мастер либо персональный мастер выбранного дубляжа.
  const sourceUri = React.useMemo(() => {
    if (!links) return null;
    const dub = links.audios[activeAudio];
    return dub?.masterUrl ?? links.files.find((f) => f.urls.hls)?.urls.hls ?? null;
  }, [links, activeAudio]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUri, loadSource]);

  // 4. Тик таймера: позиция/длительность/пауза + резюме + автосохранение.
  React.useEffect(() => {
    const timer = setInterval(() => {
      const position = player.currentTime;
      const total = Number.isFinite(player.duration) ? player.duration : 0;
      setCurrent(position);
      setDuration(total);
      setPlaying(player.playing);

      if (!appliedResumeRef.current && total > 0) {
        appliedResumeRef.current = true;
        if (resumeRef.current > 0 && resumeRef.current < total - 5) {
          player.currentTime = resumeRef.current;
          lastSaveRef.current = resumeRef.current;
        }
      }
      if (player.playing && position - lastSaveRef.current >= SAVE_EVERY_SECONDS) {
        saveProgress();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [player, saveProgress]);

  // 5. Прогресс на паузе и при уходе с экрана.
  React.useEffect(() => {
    if (!playing) saveProgress(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, saveProgress]);

  React.useEffect(
    () => () => {
      saveProgress(true);
    },
    [saveProgress],
  );

  const seekBy = (delta: number) => {
    player.currentTime = Math.max(0, Math.min(player.currentTime + delta, duration || Infinity));
    setCurrent(player.currentTime);
  };

  const changeSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    player.playbackRate = SPEEDS[next]!;
  };

  /** Субтитры: повторный клик по дорожке выключает её. */
  const selectSubtitle = React.useCallback(
    async (index: number) => {
      if (activeSub === index) {
        setActiveSub(null);
        setCues([]);
        return;
      }
      const sub = links?.subtitles[index];
      if (!sub?.url) return;
      try {
        const res = await fetch(sub.url);
        const parsed = parseVtt(await res.text());
        setCues(parsed);
        setShiftMs(sub.shiftMs ?? 0);
        setActiveSub(index);
      } catch {
        setCues([]);
        setActiveSub(null);
      }
    },
    [links, activeSub],
  );

  const activeCue = React.useMemo(
    () => (cues.length ? cueAt(cues, current, shiftMs) : null),
    [cues, current, shiftMs],
  );

  /** Дубляж: персональный мастер + восстановление позиции. */
  const changeAudio = (index: number) => {
    const dub = links?.audios[index];
    if (!dub?.masterUrl || index === activeAudio) return;
    const at = player.currentTime;
    setActiveAudio(index);
    resumeRef.current = at;
    loadSource(dub.masterUrl, at);
  };

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
              player.currentTime = ratio * duration;
              setCurrent(player.currentTime);
            }}
            accessibilityRole="button"
          >
            <View
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

        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.controlButton, focusControls[0]!.ring]}
            onPress={() => seekBy(-10)}
            accessibilityRole="button"
            {...focusControls[0]!.props}
          >
            <Text style={styles.controlText}>−10с</Text>
          </Pressable>
          <Pressable
            testID="player-play"
            style={[styles.playButton, focusPlay.ring]}
            onPress={() => (player.playing ? player.pause() : player.play())}
            accessibilityRole="button"
            hasTVPreferredFocus
            {...focusPlay.props}
          >
            <Text style={styles.playText}>{playing ? "Пауза" : "Играть"}</Text>
          </Pressable>
          <Pressable
            style={[styles.controlButton, focusControls[1]!.ring]}
            onPress={() => seekBy(10)}
            accessibilityRole="button"
            {...focusControls[1]!.props}
          >
            <Text style={styles.controlText}>+10с</Text>
          </Pressable>
          <Pressable
            testID="player-speed"
            style={[styles.controlButton, focusControls[2]!.ring]}
            onPress={changeSpeed}
            accessibilityRole="button"
            {...focusControls[2]!.props}
          >
            <Text style={styles.controlText}>{SPEEDS[speedIdx]}×</Text>
          </Pressable>
          <Pressable
            style={[styles.controlButton, focusControls[3]!.ring]}
            onPress={() => void videoRef.current?.enterFullscreen()}
            accessibilityRole="button"
            {...focusControls[3]!.props}
          >
            <Text style={styles.controlText}>На весь</Text>
          </Pressable>
        </View>

        {inIntro && intro && (
          <Pressable
            testID="player-skip-intro"
            style={[styles.introButton, focusSkipIntro.ring]}
            onPress={() => {
              player.currentTime = intro.endSeconds;
              setCurrent(intro.endSeconds);
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
            onPress={() => router.replace(`/watch/${itemIdNum}/${nextMedia}`)}
            accessibilityRole="button"
            {...focusNext.props}
          >
            <Text style={styles.controlText}>Следующая серия →</Text>
          </Pressable>
        )}

        {links && links.subtitles.length > 0 && (
          <View style={styles.dubSection}>
            <Text style={styles.sectionTitle}>Субтитры</Text>
            <View style={styles.buttonRow}>
              {links.subtitles.map((s, i) => (
                <TrackChip
                  key={s.id}
                  testID={`player-subtitle-${i}`}
                  label={s.title ?? s.lang.toUpperCase()}
                  active={i === activeSub}
                  disabled={!s.url}
                  onPress={() => void selectSubtitle(i)}
                />
              ))}
              {activeSub != null && (
                <Pressable
                  style={[styles.controlButton, focusSubOff.ring]}
                  onPress={() => void selectSubtitle(activeSub)}
                  accessibilityRole="button"
                  {...focusSubOff.props}
                >
                  <Text style={styles.controlText}>Выкл</Text>
                </Pressable>
              )}
            </View>
            {activeSub != null && (
              <View style={styles.buttonRow}>
                <Pressable
                  style={[styles.controlButton, focusShiftBack.ring]}
                  onPress={() => setShiftMs((v) => v - 100)}
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
                  onPress={() => setShiftMs((v) => v + 100)}
                  accessibilityRole="button"
                  {...focusShiftFwd.props}
                >
                  <Text style={styles.controlText}>+0.1с</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}

        {links && links.audios.length > 1 && (
          <View style={styles.dubSection}>
            <Text style={styles.sectionTitle}>Дубляж</Text>
            <View style={styles.buttonRow}>
              {links.audios.map((a, i) => (
                <TrackChip
                  key={a.id}
                  testID={`player-audio-${i}`}
                  label={
                    a.author.shortTitle ??
                    a.author.title ??
                    `${a.type} (${a.lang})`
                  }
                  active={i === activeAudio}
                  disabled={!a.masterUrl}
                  onPress={() => changeAudio(i)}
                />
              ))}
            </View>
          </View>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.color.bg,
  },
  videoWrap: {
    width: "100%",
    alignSelf: "center",
    backgroundColor: "#000",
  },
  video: {
    width: "100%",
    height: "100%",
  },
  subtitleOverlay: {
    position: "absolute",
    left: tokens.space.md,
    right: tokens.space.md,
    bottom: tokens.space.sm,
    alignItems: "center",
  },
  subtitleText: {
    color: tokens.color.text,
    backgroundColor: "rgba(0,0,0,0.65)",
    fontSize: tokens.fontSize.md,
    textAlign: "center",
    paddingHorizontal: tokens.space.sm,
    paddingVertical: 2,
    borderRadius: tokens.radius.sm,
  },
  controls: {
    flex: 1,
    backgroundColor: tokens.color.bg,
  },
  controlsContent: {
    padding: tokens.space.md,
    gap: tokens.space.sm,
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm,
  },
  time: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.xs,
    fontVariant: ["tabular-nums"],
    minWidth: 44,
    textAlign: "center",
  },
  seekbar: {
    flex: 1,
    height: 6,
    borderRadius: tokens.radius.full,
    backgroundColor: tokens.color.surfaceHover,
    overflow: "hidden",
  },
  seekFill: {
    height: "100%",
    backgroundColor: tokens.color.accent,
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.sm,
    alignItems: "center",
  },
  controlButton: {
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.full,
    borderWidth: 1,
    borderColor: tokens.color.border,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
  },
  controlActive: {
    borderColor: tokens.color.accent,
    backgroundColor: tokens.color.surfaceHover,
  },
  controlOff: {
    opacity: 0.4,
  },
  controlText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  playButton: {
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.full,
    paddingHorizontal: tokens.space.lg,
    paddingVertical: tokens.space.sm,
  },
  playText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
  },
  introButton: {
    backgroundColor: tokens.color.surfaceHover,
    borderRadius: tokens.radius.full,
    borderWidth: 1,
    borderColor: tokens.color.accent,
    alignItems: "center",
    paddingVertical: tokens.space.sm,
  },
  nextButton: {
    alignItems: "center",
    paddingVertical: tokens.space.sm,
  },
  dubSection: {
    marginTop: tokens.space.sm,
    gap: tokens.space.xs,
  },
  sectionTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.md,
    fontWeight: "700",
  },
  muted: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
  },
});
