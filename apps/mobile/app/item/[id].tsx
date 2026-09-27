"use client";

/** Карточка тайтла: инфо, голос/подписка, сезоны/эпизоды, комментарии. */
import * as React from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import type { ItemDetail, ItemSummary } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { Comments } from "../../components/comments";
import { ItemCard } from "../../components/item-card";
import { ItemActions } from "../../components/item-actions";
import { useAuth } from "../../lib/auth";
import { formatDuration } from "../../lib/format";

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const itemId = Number(id);
  const { api } = useAuth();
  const [item, setItem] = React.useState<ItemDetail | null>(null);
  const [missing, setMissing] = React.useState(false);

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

      <Similar itemId={item.id} />

      {/* Сериалы: сезоны и эпизоды */}
      {item.seasons && item.seasons.length > 0 && (
        <View style={styles.section}>
          {item.seasons.map((season) => (
            <View key={season.id} style={styles.season}>
              <Text style={styles.seasonTitle}>
                {season.title ?? `Сезон ${season.number}`}
              </Text>
              {season.episodes.map((ep) => (
                <Link
                  key={ep.id}
                  href={
                    ep.mediaId
                      ? `/watch/${item.id}/${ep.mediaId}`
                      : { pathname: "/item/[id]", params: { id: item.id } }
                  }
                  asChild
                >
                  <Pressable
                    // См. item-card: Link asChild ждёт плоский style.
                    style={StyleSheet.flatten([styles.epRow, !ep.mediaId && styles.epOff])}
                    disabled={!ep.mediaId}
                    accessibilityRole="button"
                  >
                    <Text style={styles.epNumber}>{ep.number}</Text>
                    <Text style={styles.epTitle} numberOfLines={1}>
                      {ep.title ?? `Серия ${ep.number}`}
                    </Text>
                    {ep.runtime > 0 && (
                      <Text style={styles.muted}>{formatDuration(ep.runtime)}</Text>
                    )}
                  </Pressable>
                </Link>
              ))}
            </View>
          ))}
        </View>
      )}

      {/* Фильм из нескольких частей */}
      {item.media && item.media.length > 1 && (
        <View style={styles.section}>
          {item.media.map((part) => (
            <Link key={part.id} href={`/watch/${item.id}/${part.id}`} asChild>
              <Pressable style={styles.epRow} accessibilityRole="button">
                <Text style={styles.epNumber}>{part.partNumber}</Text>
                <Text style={styles.epTitle} numberOfLines={1}>
                  {part.title ?? `Часть ${part.partNumber}`}
                </Text>
              </Pressable>
            </Link>
          ))}
        </View>
      )}

      <Comments itemId={item.id} />
    </ScrollView>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.color.bg,
  },
  content: {
    padding: tokens.space.md,
    paddingBottom: tokens.space.xl,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.color.bg,
  },
  headerRow: {
    flexDirection: "row",
    gap: tokens.space.md,
    marginBottom: tokens.space.md,
  },
  poster: {
    width: 110,
    aspectRatio: 2 / 3,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.color.surface,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.lg,
    fontWeight: "700",
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.sm,
    marginVertical: 2,
  },
  rating: {
    color: tokens.color.accent,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
  },
  muted: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
  },
  plot: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    lineHeight: 21,
    marginTop: tokens.space.md,
  },
  section: {
    marginTop: tokens.space.lg,
    gap: tokens.space.xs,
  },
  season: {
    marginBottom: tokens.space.md,
  },
  seasonTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.md,
    fontWeight: "700",
    marginBottom: tokens.space.xs,
  },
  epRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm,
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    padding: tokens.space.sm,
  },
  epOff: {
    opacity: 0.5,
  },
  epNumber: {
    color: tokens.color.accent,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
    minWidth: 24,
    textAlign: "center",
  },
  epTitle: {
    flex: 1,
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
  },
});
