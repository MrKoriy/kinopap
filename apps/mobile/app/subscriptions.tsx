"use client";

/** Мои подписки: лента нового (серии + части фильмов) и список тайтлов. */
import * as React from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Link } from "expo-router";
import type { NewEpisodeDto, SubscriptionDto } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { useAuth } from "../lib/auth";
import { feedLabel, feedTitle } from "../lib/feed";
import { formatDate } from "../lib/format";

export default function SubscriptionsScreen() {
  const { user, ready, api } = useAuth();
  const [subs, setSubs] = React.useState<SubscriptionDto[]>([]);
  const [episodes, setEpisodes] = React.useState<NewEpisodeDto[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void Promise.all([api.listSubscriptions(), api.getNewEpisodes()]).then(
      ([s, e]) => {
        if (cancelled) return;
        setSubs(s.items);
        setEpisodes(e.items);
        setLoading(false);
      },
      () => {
        if (!cancelled) setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, user]);

  const unsubscribe = React.useCallback(
    async (itemId: number) => {
      const prev = subs;
      setSubs((cur) => cur.filter((s) => s.itemId !== itemId));
      try {
        await api.unsubscribe(itemId);
      } catch {
        setSubs(prev);
      }
    },
    [api, subs],
  );

  if (ready && !user) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Войдите, чтобы видеть подписки.</Text>
        <Link href="/login" asChild>
          <Pressable style={styles.loginButton}>
            <Text style={styles.loginText}>Войти</Text>
          </Pressable>
        </Link>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={episodes}
      keyExtractor={(ep) => String(ep.mediaId)}
      ListHeaderComponent={
        <Text style={styles.title}>Новое по подпискам</Text>
      }
      ListEmptyComponent={
        loading ? (
          <ActivityIndicator color={tokens.color.accent} style={styles.loader} />
        ) : (
          <Text style={styles.muted}>Нового нет — всё просмотрено.</Text>
        )
      }
      renderItem={({ item }) => (
        <Link href={`/watch/${item.itemId}/${item.mediaId}`} asChild>
          <Pressable style={styles.epRow} accessibilityRole="button">
            <Text style={styles.epLabel}>{feedLabel(item)}</Text>
            <View style={styles.epText}>
              <Text style={styles.epTitle} numberOfLines={1}>
                {feedTitle(item)}
              </Text>
              <Text style={styles.muted}>{formatDate(item.publishedAt)}</Text>
            </View>
          </Pressable>
        </Link>
      )}
      ListFooterComponent={
        <View style={styles.footer}>
          <Text style={styles.title}>Тайтлы</Text>
          {subs.length === 0 && !loading && (
            <Text style={styles.muted}>Подписок пока нет.</Text>
          )}
          {subs.map((s) => (
            <View key={s.itemId} style={styles.subRow}>
              <Link href={`/item/${s.itemId}`} asChild>
                <Pressable style={styles.subTitle} accessibilityRole="button">
                  <Text style={styles.epTitle}>
                    {s.item.title}
                    {s.item.year ? ` (${s.item.year})` : ""}
                  </Text>
                </Pressable>
              </Link>
              <Pressable onPress={() => void unsubscribe(s.itemId)} accessibilityRole="button">
                <Text style={styles.unsubText}>Отписаться</Text>
              </Pressable>
            </View>
          ))}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.color.bg,
  },
  content: {
    padding: tokens.space.md,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.space.md,
    backgroundColor: tokens.color.bg,
  },
  title: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.lg,
    fontWeight: "700",
    marginBottom: tokens.space.sm,
    marginTop: tokens.space.sm,
  },
  loader: {
    marginVertical: tokens.space.md,
  },
  muted: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
  },
  epRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm,
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    padding: tokens.space.sm,
    marginBottom: tokens.space.xs,
  },
  epLabel: {
    color: tokens.color.accent,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
    minWidth: 64,
  },
  epText: {
    flex: 1,
  },
  epTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  footer: {
    marginTop: tokens.space.lg,
  },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    padding: tokens.space.sm,
    marginBottom: tokens.space.xs,
  },
  subTitle: {
    flex: 1,
  },
  unsubText: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.xs,
  },
  loginButton: {
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.full,
    paddingHorizontal: tokens.space.lg,
    paddingVertical: tokens.space.sm,
  },
  loginText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
  },
});
