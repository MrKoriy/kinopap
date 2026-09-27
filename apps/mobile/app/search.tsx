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
import { useTvFocus } from "../components/tv-focus";
import { useAuth } from "../lib/auth";

type SearchField = "title" | "director" | "cast";

const FIELDS: { id: SearchField | ""; title: string }[] = [
  { id: "", title: "Везде" },
  { id: "title", title: "Название" },
  { id: "director", title: "Режиссёр" },
  { id: "cast", title: "Актёры" },
];

export default function SearchScreen() {
  const { api } = useAuth();
  const [query, setQuery] = React.useState("");
  const [field, setField] = React.useState<SearchField | "">("");
  const [results, setResults] = React.useState<ItemSummary[]>([]);
  const [searched, setSearched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const focusSubmit = useTvFocus();

  const runSearch = React.useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    try {
      const page = await api.searchItems({
        q,
        field: field || undefined,
        limit: 30,
      });
      setResults(page.items);
      setSearched(true);
    } finally {
      setBusy(false);
    }
  }, [api, query, field]);

  return (
    <View testID="search-screen" style={styles.container}>
      <View style={styles.searchRow}>
        <TextInput
          testID="search-input"
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
          testID="search-submit"
          style={[styles.button, focusSubmit.ring]}
          onPress={() => void runSearch()}
          accessibilityRole="button"
          hasTVPreferredFocus
          {...focusSubmit.props}
        >
          <Text style={styles.buttonText}>Найти</Text>
        </Pressable>
      </View>

      <View style={styles.fieldsRow}>
        {FIELDS.map((f) => (
          <FieldChip
            key={f.id}
            title={f.title}
            active={field === f.id}
            onSelect={() => setField(f.id)}
          />
        ))}
      </View>

      {busy && <ActivityIndicator color={tokens.color.accent} style={styles.loader} />}

      {searched && !busy && results.length === 0 && (
        <Text style={styles.empty}>Ничего не нашлось.</Text>
      )}

      <FlatList
        testID="search-results"
        data={results}
        numColumns={3}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item, index }) => (
          <View style={styles.cell}>
            <ItemCard item={item} width={104} preferredFocus={index === 0} />
          </View>
        )}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

/** Чип выбора поля поиска — отдельный компонент ради фокуса пульта. */
function FieldChip({
  title,
  active,
  onSelect,
}: {
  title: string;
  active: boolean;
  onSelect: () => void;
}) {
  const focus = useTvFocus();
  return (
    <Pressable
      style={[styles.fieldChip, active && styles.fieldChipActive, focus.ring]}
      onPress={onSelect}
      accessibilityRole="button"
      aria-selected={active}
      {...focus.props}
    >
      <Text style={styles.fieldText}>{title}</Text>
    </Pressable>
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
  fieldsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.sm,
    marginBottom: tokens.space.md,
  },
  fieldChip: {
    borderRadius: tokens.radius.full,
    backgroundColor: tokens.color.surface,
    borderWidth: 1,
    borderColor: tokens.color.border,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.xs,
  },
  fieldChipActive: {
    backgroundColor: tokens.color.accent,
    borderColor: tokens.color.accent,
  },
  fieldText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
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
