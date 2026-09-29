"use client";

import type {
  Episode,
  ItemDetail,
  ItemProgressDto,
  ItemSummary,
  MediaPart,
  Season,
} from "@zal/api-client";
import { tokens } from "@zal/ui";
import { Link, useLocalSearchParams } from "expo-router";
/**
 * Карточка тайтла: инфо, голос/подписка, трейлер, сезоны/эпизоды, комментарии.
 * Сериал открывается одним сезоном (чипы), у серии видно, начата ли она и
 * досмотрена ли, а главная кнопка ведёт в последнюю начатую серию.
 */
import * as React from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Comments } from "../../components/comments";
import { ItemActions } from "../../components/item-actions";
import { ItemCard } from "../../components/item-card";
import { useTvFocus } from "../../components/tv-focus";
import { useAuth } from "../../lib/auth";
import { formatDuration } from "../../lib/format";
import { trailerTarget } from "../../lib/trailer";
import {
  pickDefaultSeason,
  primaryPlay,
  progressByMedia,
  type WatchState,
  watchStateOf,
} from "../../lib/watch-state";
import { styles } from "./[id].styles";

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const itemId = Number(id);
  const { api, user } = useAuth();
  const focusWatch = useTvFocus();
  const [item, setItem] = React.useState<ItemDetail | null>(null);
  const [missing, setMissing] = React.useState(false);
  const [progress, setProgress] = React.useState<ItemProgressDto | null>(null);
  // null — сезон выбран автоматически (прогресс/первый); явный выбор важнее.
  const [pickedSeasonId, setPickedSeasonId] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api.getItem(itemId).then(
      (res) => {
        if (cancelled) return;
        if (res) setItem(res);
        else setMissing(true);
      },
      () => {
        if (!cancelled) setMissing(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, itemId]);

  // Прогресс — только для авторизованного: у гостя его попросту нет, а запрос
  // к защищённому эндпоинту гонял бы refresh вхолостую.
  React.useEffect(() => {
    if (!user) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    api.getItemProgress(itemId).then(
      (res) => {
        if (!cancelled) setProgress(res.progress);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, itemId, user]);

  const seasons = item?.seasons ?? [];
  const byMedia = React.useMemo(() => progressByMedia(progress), [progress]);
  const autoSeasonId = React.useMemo(
    () => pickDefaultSeason(seasons, progress),
    [seasons, progress],
  );
  const activeSeason =
    seasons.find((s) => s.id === (pickedSeasonId ?? autoSeasonId)) ?? seasons[0] ?? null;
  const play = item ? primaryPlay(item, progress) : null;

  if (missing) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Тайтл не найден.</Text>
      </View>
    );
  }
  if (!item) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={tokens.color.accent} />
      </View>
    );
  }

  const poster = item.posters.big ?? item.posters.medium;
  const rating = item.rating > 0 ? item.rating : item.imdb.rating;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        {poster && (
          <Image source={{ uri: poster }} style={styles.poster} resizeMode="cover" />
        )}
        <View style={styles.headerText}>
          <Text style={styles.title}>{item.title}</Text>
          {item.originalTitle && (
            <Text style={styles.muted}>{item.originalTitle}</Text>
          )}
          <View style={styles.metaRow}>
            {rating !== null && rating > 0 && (
              <Text style={styles.rating}>★ {rating.toFixed(1)}</Text>
            )}
            {item.year != null && <Text style={styles.muted}>{item.year}</Text>}
            {item.duration.average != null && item.duration.average > 0 && (
              <Text style={styles.muted}>{formatDuration(item.duration.average)}</Text>
            )}
          </View>
          <Text style={styles.muted}>
            {item.genres.map((g) => g.title).join(", ")}
          </Text>
        </View>
      </View>

      <ItemActions itemId={item.id} />

      {item.plot && <Text style={styles.plot}>{item.plot}</Text>}

      {/* Главная кнопка. Одночастевый фильм: без неё фильм было не запустить.
          Сериал и многочастевый фильм ведут в resumeMediaId, иначе в первую
          серию — раньше у них пуска не было вообще. */}
      {play && (
        <Link href={`/watch/${item.id}/${play.mediaId}`} asChild>
          <Pressable
            testID="watch-button"
            // См. item-card: Link asChild ждёт плоский style.
            style={StyleSheet.flatten([styles.watchButton, focusWatch.ring])}
            accessibilityRole="button"
            hasTVPreferredFocus
            {...focusWatch.props}
          >
            <Text style={styles.watchText}>{play.label}</Text>
          </Pressable>
        </Link>
      )}

      <TrailerButton item={item} />

      <Similar itemId={item.id} />

      {/* Сериалы: чипы сезонов + серии выбранного сезона */}
      {seasons.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.seasonTitle}>Сезоны</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            {seasons.map((season) => (
              <SeasonChip
                key={season.id}
                season={season}
                active={season.id === activeSeason?.id}
                onSelect={() => setPickedSeasonId(season.id)}
              />
            ))}
          </ScrollView>
          {activeSeason?.episodes.map((ep) => (
            <EpisodeRow
              key={ep.id}
              itemId={item.id}
              ep={ep}
              state={watchStateOf(ep.mediaId != null ? byMedia.get(ep.mediaId) : undefined)}
            />
          ))}
        </View>
      )}

      {/* Фильм из нескольких частей */}
      {item.media && item.media.length > 1 && (
        <View style={styles.section}>
          {item.media.map((part) => (
            <PartRow key={part.id} itemId={item.id} part={part} />
          ))}
        </View>
      )}

      <Comments itemId={item.id} />
    </ScrollView>
  );
}

/** Чип сезона — отдельный компонент ради фокуса пульта. */
function SeasonChip({
  season,
  active,
  onSelect,
}: {
  season: Season;
  active: boolean;
  onSelect: () => void;
}) {
  const focus = useTvFocus();
  return (
    <Pressable
      testID={`season-chip-${season.number}`}
      style={[styles.chip, active && styles.chipActive, focus.ring]}
      onPress={onSelect}
      accessibilityRole="button"
      aria-selected={active}
      {...focus.props}
    >
      <Text style={styles.chipText}>{season.title ?? `Сезон ${season.number}`}</Text>
    </Pressable>
  );
}

/** Строка эпизода: Link asChild требует плоский style, фокус — для пульта. */
function EpisodeRow({
  itemId,
  ep,
  state,
}: {
  itemId: number;
  ep: Episode;
  state: WatchState;
}) {
  const focus = useTvFocus();
  return (
    <Link
      href={
        ep.mediaId
          ? `/watch/${itemId}/${ep.mediaId}`
          : { pathname: "/item/[id]", params: { id: itemId } }
      }
      asChild
    >
      <Pressable
        testID="episode-row"
        style={StyleSheet.flatten([styles.epRow, !ep.mediaId && styles.epOff, focus.ring])}
        disabled={!ep.mediaId}
        accessibilityRole="button"
        {...focus.props}
      >
        {ep.thumbnailUrl && (
          <Image source={{ uri: ep.thumbnailUrl }} style={styles.epThumb} resizeMode="cover" />
        )}
        <Text style={styles.epNumber}>{ep.number}</Text>
        <View style={styles.epBody}>
          <Text style={styles.epTitle} numberOfLines={1}>
            {ep.title ?? `Серия ${ep.number}`}
          </Text>
          {state.kind === "progress" && (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${state.progress * 100}%` }]} />
            </View>
          )}
        </View>
        {ep.runtime > 0 && (
          <Text style={styles.muted}>{formatDuration(ep.runtime)}</Text>
        )}
        {state.kind === "done" && <Text style={styles.doneMark}>✓</Text>}
      </Pressable>
    </Link>
  );
}

/** Часть многочастевого фильма. */
function PartRow({ itemId, part }: { itemId: number; part: MediaPart }) {
  const focus = useTvFocus();
  return (
    <Link href={`/watch/${itemId}/${part.id}`} asChild>
      <Pressable
        style={StyleSheet.flatten([styles.epRow, focus.ring])}
        accessibilityRole="button"
        {...focus.props}
      >
        {part.thumbnailUrl && (
          <Image source={{ uri: part.thumbnailUrl }} style={styles.epThumb} resizeMode="cover" />
        )}
        <Text style={styles.epNumber}>{part.partNumber}</Text>
        <Text style={styles.epTitle} numberOfLines={1}>
          {part.title ?? `Часть ${part.partNumber}`}
        </Text>
      </Pressable>
    </Link>
  );
}

/**
 * Трейлер открывается внешним YouTube-приложением/браузером: в приложении
 * нет WebView, а встраивать плеер в нативный экран нечем. Если ролика нет —
 * кнопка честно предлагает поиск, а не открывает пустой URL.
 */
function TrailerButton({ item }: { item: ItemDetail }) {
  const focus = useTvFocus();
  const target = trailerTarget(item);
  return (
    <Pressable
      testID="trailer-button"
      style={[styles.trailerButton, focus.ring]}
      onPress={() => {
        if (target.url) void Linking.openURL(target.url);
      }}
      accessibilityRole="button"
      {...focus.props}
    >
      <Text style={styles.trailerText}>{target.label}</Text>
    </Pressable>
  );
}

/** Рекомендации: похожие тайтлы по общим жанрам. */
function Similar({ itemId }: { itemId: number }) {
  const { api } = useAuth();
  const [similar, setSimilar] = React.useState<ItemSummary[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    api.getSimilar(itemId).then(
      (res) => {
        if (!cancelled) setSimilar(res.items);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, itemId]);

  if (similar.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.seasonTitle}>Похожее</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {similar.map((s) => (
          <ItemCard key={s.id} item={s} />
        ))}
      </ScrollView>
    </View>
  );
}
