"use client";

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
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { VideoView, useVideoPlayer, type VideoSource } from "expo-video";
import type { ItemDetail, MediaLinks } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { useAuth } from "../../../lib/auth";
import { formatTime } from "../../../lib/format";

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

  // Таймер плеера.
  const [current, setCurrent] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [barWidth, setBarWidth] = React.useState(0);

  const resumeRef = React.useRef(0);
  const appliedResumeRef = React.useRef(false);
  const lastSaveRef = React.useRef(0);
  const videoRef = React.useRef<React.ComponentRef<typeof VideoView>>(null);

  const player = useVideoPlayer(null, (p) => {
    p.play();
  });

  // 1. Ссылки + позиция резюме.
  React.useEffect(() => {
    let cancelled = false;
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
  }, [sourceUri]);

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
  }, [playing]);

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
    <View style={styles.container}>
      <VideoView
        ref={videoRef}
        player={player}
        style={styles.video}
        contentFit="contain"
        nativeControls={false}
      />

      {!links && (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.color.accent} />
        </View>
      )}

      <ScrollView style={styles.controls} contentContainerStyle={styles.controlsContent}>
        <View style={styles.timeRow}>
          <Text style={styles.time}>{formatTime(current)}</Text>
          <Pressable
            style={styles.seekbar}
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
          <Text style={styles.time}>{formatTime(duration)}</Text>
        </View>

        <View style={styles.buttonRow}>
          <Pressable style={styles.controlButton} onPress={() => seekBy(-10)}>
            <Text style={styles.controlText}>−10с</Text>
          </Pressable>
          <Pressable
            style={styles.playButton}
            onPress={() => (player.playing ? player.pause() : player.play())}
            accessibilityRole="button"
          >
            <Text style={styles.playText}>{playing ? "Пауза" : "Играть"}</Text>
          </Pressable>
          <Pressable style={styles.controlButton} onPress={() => seekBy(10)}>
            <Text style={styles.controlText}>+10с</Text>
          </Pressable>
          <Pressable style={styles.controlButton} onPress={changeSpeed}>
            <Text style={styles.controlText}>{SPEEDS[speedIdx]}×</Text>
          </Pressable>
          <Pressable
            style={styles.controlButton}
            onPress={() => void videoRef.current?.enterFullscreen()}
          >
            <Text style={styles.controlText}>На весь</Text>
          </Pressable>
        </View>

        {inIntro && intro && (
          <Pressable
            style={styles.introButton}
            onPress={() => {
              player.currentTime = intro.endSeconds;
              setCurrent(intro.endSeconds);
            }}
            accessibilityRole="button"
          >
            <Text style={styles.playText}>Пропустить интро</Text>
          </Pressable>
        )}

        {nextMedia && (
          <Pressable
            style={styles.nextButton}
            onPress={() => router.push(`/watch/${itemIdNum}/${nextMedia}`)}
            accessibilityRole="button"
          >
            <Text style={styles.controlText}>Следующая серия →</Text>
          </Pressable>
        )}

        {links && links.audios.length > 1 && (
          <View style={styles.dubSection}>
            <Text style={styles.sectionTitle}>Дубляж</Text>
            <View style={styles.buttonRow}>
              {links.audios.map((a, i) => {
                const label =
                  a.author.shortTitle ?? a.author.title ?? `${a.type} (${a.lang})`;
                return (
                  <Pressable
                    key={a.id}
                    style={[
                      styles.controlButton,
                      i === activeAudio && styles.controlActive,
                      !a.masterUrl && styles.controlOff,
                    ]}
                    disabled={!a.masterUrl}
                    onPress={() => changeAudio(i)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.controlText}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
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
  video: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#000",
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
