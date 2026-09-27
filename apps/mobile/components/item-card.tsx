"use client";

/** Карточка тайтла: постер, название, рейтинг. */
import * as React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Link } from "expo-router";
import type { ItemSummary } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { useTvFocus } from "./tv-focus";

export function ItemCard({
  item,
  width = 140,
  preferredFocus = false,
}: {
  item: ItemSummary;
  width?: number;
  /** TV: первый элемент ленты забирает фокус при входе на экран. */
  preferredFocus?: boolean;
}) {
  const poster = item.posters.medium ?? item.posters.small ?? item.posters.big;
  const rating = item.rating > 0 ? item.rating : item.imdb.rating;
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
        {poster ? (
          <Image source={{ uri: poster }} style={styles.poster} resizeMode="cover" />
        ) : (
          <View style={[styles.poster, styles.placeholder]}>
            <Text style={styles.placeholderText}>Зал.</Text>
          </View>
        )}
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        <View style={styles.metaRow}>
          {rating !== null && rating > 0 && (
            <Text style={styles.rating}>★ {rating.toFixed(1)}</Text>
          )}
          {item.year != null && <Text style={styles.year}>{item.year}</Text>}
        </View>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
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
