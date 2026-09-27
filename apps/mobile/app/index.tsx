"use client";

/**
 * Главная: горизонтальные ленты fresh/hot/popular из общего API,
 * входы в поиск и подписки, состояние авторизации.
 */
import * as React from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Link, useRouter } from "expo-router";
import type { ItemSummary } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { ItemCard } from "../components/item-card";
import { useAuth } from "../lib/auth";

type ShortcutKind = "fresh" | "hot" | "popular";

const SECTIONS: { kind: ShortcutKind; title: string }[] = [
  { kind: "fresh", title: "Новинки" },
  { kind: "hot", title: "Сейчас смотрят" },
  { kind: "popular", title: "Популярное" },
];

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
  const [sections, setSections] = React.useState<
    Record<ShortcutKind, ItemSummary[]>
  >({ fresh: [], hot: [], popular: [] });
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all(
      SECTIONS.map((s) => api.getShortcut(s.kind, { limit: 10 })),
    ).then(
      (pages) => {
        if (cancelled) return;
        setSections({
          fresh: pages[0]!.items,
          hot: pages[1]!.items,
          popular: pages[2]!.items,
        });
        setLoading(false);
      },
      () => {
        if (!cancelled) setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.topRow}>
        <Pressable
          testID="search-link"
          style={styles.navButton}
          onPress={() => router.push("/search")}
          accessibilityRole="button"
        >
          <Text style={styles.navText}>Поиск</Text>
        </Pressable>
        <Pressable
          testID="subs-link"
          style={styles.navButton}
          onPress={() => router.push("/subscriptions")}
          accessibilityRole="button"
        >
          <Text style={styles.navText}>Подписки</Text>
        </Pressable>
        {ready && !user && (
          <Link href="/login" asChild>
            <Pressable
              testID="login-link"
              style={styles.loginButton}
              accessibilityRole="button"
            >
              <Text style={styles.loginText}>Войти</Text>
            </Pressable>
          </Link>
        )}
        {user && (
          <Pressable
            testID="logout-button"
            style={styles.navButton}
            onPress={() => void logout()}
            accessibilityRole="button"
          >
            <Text style={styles.navText}>Выйти ({user.name})</Text>
          </Pressable>
        )}
      </View>

      {loading && <ActivityIndicator color={tokens.color.accent} style={styles.loader} />}

      {SECTIONS.map((section) => (
        <View key={section.kind} style={styles.section}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          <FlatList
            horizontal
            data={sections[section.kind]}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => <ItemCard item={item} />}
            showsHorizontalScrollIndicator={false}
          />
        </View>
      ))}
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
