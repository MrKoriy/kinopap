"use client";

import type { ItemSummary } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { Link } from "expo-router";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useTvFocus } from "./tv-focus";

export function ItemCard({
  item,
  width = 140,
  preferredFocus = false,
  rank,
}: {
  item: ItemSummary;
  width?: number;
  /** Место в Топ-10: крупная цифра поверх постера. */
  rank?: number;
  /** TV: первый элемент ленты забирает фокус при входе на экран. */
  preferredFocus?: boolean;
}) {
  const poster = item.posters.medium ?? item.posters.small ?? item.posters.big;
  const rating =
    item.rating > 0
      ? item.rating
      : ([item.imdb.rating, item.tmdb.rating, item.kinopoisk.rating].find((r) => r != null && r > 0) ?? null);
  const ratingColor = rating == null ? null : rating >= 7 ? "#059669" : rating >= 5 ? "#d97706" : "#000000b3";
  const focus = useTvFocus();

  return (
    <Link href={`/item/${item.id}`} asChild>
      <Pressable
        testID="item-card"
        // expo-router Link asChild требует один плоский style, не массив.
        style={StyleSheet.flatten([styles.card, { width }, focus.ring])}
        accessibilityRole="button"
        hasTVPreferredFocus={preferredFocus}
        {...focus.props}
      >
        <View>
          {poster ? (
            <Image source={{ uri: poster }} style={styles.poster} resizeMode="cover" />
          ) : (
            <View style={[styles.poster, styles.placeholder]}>
              <Text style={styles.placeholderText}>kino.pap</Text>
            </View>
          )}
          {rating != null && rating > 0 && ratingColor && (
            <View style={[styles.ratingBadge, { backgroundColor: ratingColor }]}>
              <Text style={styles.ratingBadgeText}>{rating.toFixed(1)}</Text>
            </View>
          )}
          {rank != null && (
            <Text testID="item-card-rank" style={styles.rank}>
              {rank}
            </Text>
          )}
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        <View style={styles.metaRow}>
          {item.year != null && <Text style={styles.year}>{item.year}</Text>}
        </View>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  ratingBadge: {
    position: "absolute",
    top: 6,
    left: 6,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  ratingBadgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  rank: {
    position: "absolute",
    left: -2,
    bottom: -14,
    fontSize: 64,
    fontWeight: "900",
    color: tokens.color.bg,
    textShadowColor: "#ffffffcc",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 3,
  },
  card: {
    marginRight: tokens.space.sm,
  },
  poster: {
    width: "100%",
    aspectRatio: 2 / 3,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.color.surface,
  },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.lg,
    fontWeight: "700",
  },
  title: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
    marginTop: tokens.space.xs,
  },
  metaRow: {
    flexDirection: "row",
    gap: tokens.space.sm,
    marginTop: 2,
  },
  rating: {
    color: tokens.color.accent,
    fontSize: tokens.fontSize.xs,
    fontWeight: "600",
  },
  year: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.xs,
  },
});
