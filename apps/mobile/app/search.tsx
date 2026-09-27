"use client";

/** Поиск с pg_trgm: запрос и плоская выдача карточек. */
import * as React from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ItemSummary } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { ItemCard } from "../components/item-card";
import { useAuth } from "../lib/auth";

export default function SearchScreen() {
  const { api } = useAuth();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<ItemSummary[]>([]);
  const [searched, setSearched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const runSearch = React.useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    try {
      const page = await api.searchItems({ q, limit: 30 });
      setResults(page.items);
      setSearched(true);
    } finally {
      setBusy(false);
    }
  }, [api, query]);

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Название, режиссёр, актёр…"
          placeholderTextColor={tokens.color.textMuted}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => void runSearch()}
          returnKeyType="search"
          autoCapitalize="none"
        />
        <Pressable
          style={styles.button}
          onPress={() => void runSearch()}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Найти</Text>
        </Pressable>
      </View>

      {busy && <ActivityIndicator color={tokens.color.accent} style={styles.loader} />}

      {searched && !busy && results.length === 0 && (
        <Text style={styles.empty}>Ничего не нашлось.</Text>
      )}

      <FlatList
        data={results}
        numColumns={3}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <View style={styles.cell}>
            <ItemCard item={item} width={104} />
          </View>
        )}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.color.bg,
    padding: tokens.space.md,
  },
  searchRow: {
    flexDirection: "row",
    gap: tokens.space.sm,
    marginBottom: tokens.space.md,
  },
  input: {
    flex: 1,
    backgroundColor: tokens.color.surface,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: tokens.color.border,
    color: tokens.color.text,
    fontSize: tokens.fontSize.md,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
  },
  button: {
    backgroundColor: tokens.color.accent,
    borderRadius: tokens.radius.md,
    justifyContent: "center",
    paddingHorizontal: tokens.space.md,
  },
  buttonText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "700",
  },
  loader: {
    marginVertical: tokens.space.md,
  },
  empty: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
    textAlign: "center",
    marginTop: tokens.space.lg,
  },
  list: {
    gap: tokens.space.md,
  },
  cell: {
    flex: 1 / 3,
    alignItems: "center",
  },
});
