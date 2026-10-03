"use client";

import type { ItemSummary } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { Link, useRouter } from "expo-router";
/**
 * Главная: Топ-10, свежее, ленты по типам и высокий рейтинг из общего API,
 * входы в поиск и подписки, состояние авторизации.
 */
import * as React from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ItemCard } from "../components/item-card";
import { useTvFocus } from "../components/tv-focus";
import { useAuth } from "../lib/auth";

type SectionKey = "hot" | "fresh" | "movie" | "serial" | "anime" | "top";

/** Ленты главной — как на вебе: Топ-10, свежее, по типам, высокий рейтинг. */
const SECTIONS: { key: SectionKey; title: string; ranked?: boolean }[] = [
  { key: "hot", title: "Топ-10 сегодня", ranked: true },
  { key: "fresh", title: "Свежее" },
  { key: "movie", title: "Фильмы" },
  { key: "serial", title: "Сериалы" },
  { key: "anime", title: "Аниме" },
  { key: "top", title: "Высокий рейтинг" },
];

const EMPTY_SECTIONS: Record<SectionKey, ItemSummary[]> = {
  hot: [],
  fresh: [],
  movie: [],
  serial: [],
  anime: [],
  top: [],
};

export default function HomeScreen() {
  const { user, ready, api, logout } = useAuth();
  const router = useRouter();

  // QA-хук: EXPO_PUBLIC_INITIAL_ROUTE=/watch/1/1 уводит приложение сразу на
  // нужный экран — так автоматические прогоны на симуляторе снимают плеер,
  // не тыкая в UI (системный диалог deep-link'а мешает simctl openurl).
  React.useEffect(() => {
    const initial = process.env.EXPO_PUBLIC_INITIAL_ROUTE;
    if (initial) router.replace(initial as never);
  }, [router]);
  const [sections, setSections] = React.useState<Record<SectionKey, ItemSummary[]>>(EMPTY_SECTIONS);
  const [loading, setLoading] = React.useState(true);
  // Сетевой сбой отдельным флагом: без него пустые ленты выглядели бы как
  // «просто ничего нового», а не как «не загрузилось».
  const [failed, setFailed] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const focusRetry = useTvFocus();
  const focusNav = [
    useTvFocus(),
    useTvFocus(),
    useTvFocus(),
    useTvFocus(),
    useTvFocus(),
  ];

  // Загрузка вынесена в функцию: её зовут и эффект, и «Повторить», и
  // pull-to-refresh — один и тот же путь данных.
  const loadSections = React.useCallback(async () => {
    try {
      const byViews = { field: "views" as const, dir: "desc" as const };
      const [hot, fresh, movie, serial, anime, top] = await Promise.all([
        api.getShortcut("hot", { limit: 10 }),
        api.getShortcut("fresh", { limit: 12 }),
        api.listItems({ type: "movie", sort: byViews, limit: 12 }),
        api.listItems({ type: "serial", sort: byViews, limit: 12 }),
        api.listItems({ type: "anime", sort: byViews, limit: 12 }),
        api.getShortcut("popular", { limit: 12 }),
      ]);
      setSections({
        hot: hot.items,
        fresh: fresh.items,
        movie: movie.items,
        serial: serial.items,
        anime: anime.items,
        top: top.items,
      });
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    void loadSections();
  }, [loadSections]);

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await loadSections();
    setRefreshing(false);
  }, [loadSections]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />
      }
    >
      <View style={styles.topRow}>
        <Pressable
          testID="search-link"
          style={[styles.navButton, focusNav[0]!.ring]}
          onPress={() => router.push("/search")}
          accessibilityRole="button"
          hasTVPreferredFocus
          {...focusNav[0]!.props}
        >
          <Text style={styles.navText}>Поиск</Text>
        </Pressable>
        <Pressable
          testID="subs-link"
          style={[styles.navButton, focusNav[1]!.ring]}
          onPress={() => router.push("/subscriptions")}
          accessibilityRole="button"
          {...focusNav[1]!.props}
        >
          <Text style={styles.navText}>Подписки</Text>
        </Pressable>
        <Pressable
          testID="profile-link"
          style={[styles.navButton, focusNav[2]!.ring]}
          onPress={() => router.push("/profile")}
          accessibilityRole="button"
          {...focusNav[2]!.props}
        >
          <Text style={styles.navText}>Профиль</Text>
        </Pressable>
        {ready && !user && (
          <Link href="/login" asChild>
            <Pressable
              testID="login-link"
              // См. item-card: Link asChild требует плоский style, не массив.
              style={StyleSheet.flatten([styles.loginButton, focusNav[3]!.ring])}
              accessibilityRole="button"
              {...focusNav[3]!.props}
            >
              <Text style={styles.loginText}>Войти</Text>
            </Pressable>
          </Link>
        )}
        {user && (
          <Pressable
            testID="logout-button"
            style={[styles.navButton, focusNav[4]!.ring]}
            onPress={() => void logout()}
            accessibilityRole="button"
            {...focusNav[4]!.props}
          >
            <Text style={styles.navText}>Выйти ({user.name})</Text>
          </Pressable>
        )}
      </View>

      {loading && <ActivityIndicator color={tokens.color.accent} style={styles.loader} />}

      {/* Сетевой сбой: пустые ленты должны отличаться от «ничего нового». */}
      {!loading && failed && (
        <View style={styles.failedBox}>
          <Text style={styles.failedText}>Ленты не загрузились</Text>
          <Pressable
            testID="retry-button"
            style={[styles.retryButton, focusRetry.ring]}
            onPress={() => void loadSections()}
            accessibilityRole="button"
            {...focusRetry.props}
          >
            <Text style={styles.retryText}>Повторить</Text>
          </Pressable>
        </View>
      )}

      {SECTIONS.map((section) =>
        sections[section.key].length === 0 ? null : (
          <View key={section.key} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <FlatList
              horizontal
              data={sections[section.key]}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item, index }) => (
                <ItemCard
                  item={item}
                  rank={section.ranked ? index + 1 : undefined}
                  preferredFocus={section.key === "hot" && index === 0}
                />
              )}
              showsHorizontalScrollIndicator={false}
            />
          </View>
        ),
      )}
    </ScrollView>
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
  topRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.space.sm,
    marginBottom: tokens.space.md,
  },
  navButton: {
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.full,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
    borderWidth: 1,
    borderColor: tokens.color.border,
  },
  navText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
  },
  loginButton: {
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.full,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
  },
  loginText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  loader: {
    marginVertical: tokens.space.lg,
  },
  failedBox: {
    alignItems: "center",
    gap: tokens.space.sm,
    marginVertical: tokens.space.lg,
  },
  failedText: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
  },
  retryButton: {
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.full,
    borderWidth: 1,
    borderColor: tokens.color.border,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
  },
  retryText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  section: {
    marginBottom: tokens.space.lg,
  },
  sectionTitle: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.lg,
    fontWeight: "700",
    marginBottom: tokens.space.sm,
  },
});
