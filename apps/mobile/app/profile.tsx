"use client";

import type {
  FavoriteDto,
  HistoryEntryDto,
  ProfileItem,
  ProfileStats,
  UserListDetailDto,
  UserListDto,
} from "@zal/api-client";
import { useProfileActions } from "@zal/shared/react";
import { tokens } from "@zal/ui";
import { Link, useRouter } from "expo-router";
/**
 * Профиль: счётчики, история просмотра, сохранённое и подборки.
 * Всё личное — за авторизацией; мутации оптимистичные, при ошибке откат.
 */
import * as React from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTvFocus } from "../components/tv-focus";
import { useAuth } from "../lib/auth";
import { formatRelativeTime } from "../lib/format";
import { historyLabel } from "../lib/watch-state";
import { styles } from "./profile.styles";

export default function ProfileScreen() {
  const { user, ready, api } = useAuth();
  const router = useRouter();
  const focusLogin = useTvFocus();

  const [stats, setStats] = React.useState<ProfileStats | null>(null);
  const [history, setHistory] = React.useState<HistoryEntryDto[]>([]);
  const [favorites, setFavorites] = React.useState<FavoriteDto[]>([]);
  const [lists, setLists] = React.useState<UserListDto[]>([]);
  const [openList, setOpenList] = React.useState<UserListDetailDto | null>(null);
  const [loading, setLoading] = React.useState(true);
  // Подтверждение очистки — inline, а не Alert: Alert не работает на web, а
  // на TV требует нажатий пульта, которые не отрисовываются как кнопки.
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [newListTitle, setNewListTitle] = React.useState("");

  React.useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.getProfileOverview().then(
      (res) => {
        if (cancelled) return;
        setStats(res.profile.stats);
        setHistory(res.profile.history);
        setFavorites(res.profile.favorites);
        setLists(res.profile.lists);
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

  // Общий цикл оптимистичных апдейтов (снимок → сеттеры → API → откат) —
  // хук из @zal/shared/react. Мобильный при сбое счётчики сводки не
  // возвращает — политика передана явно, а не спрятана внутри.
  const actions = useProfileActions({
    api,
    state: { stats, history, favorites, lists, openList },
    setters: { setStats, setHistory, setFavorites, setLists, setOpenList },
    revertStatsOnFailure: false,
  });

  // Панель подтверждения скрывается сразу и откатом не возвращается.
  const clearHistory = React.useCallback(async () => {
    setConfirmClear(false);
    await actions.clearHistory();
  }, [actions]);

  const createList = React.useCallback(async () => {
    const title = newListTitle.trim();
    if (!title) return;
    try {
      const res = await api.createList({ title, isPublic: false });
      setLists((cur) => [...cur, res.list]);
      setStats((s) => (s ? { ...s, lists: s.lists + 1 } : s));
      setNewListTitle("");
    } catch {
      // Ошибка создания — просто не добавляем строку; ввод остаётся в поле.
    }
  }, [api, newListTitle]);

  /** Повторный тап по подборке сворачивает её — не держим лишний запрос. */
  const toggleList = React.useCallback(
    async (listId: number) => {
      if (openList?.id === listId) {
        setOpenList(null);
        return;
      }
      try {
        const res = await api.getList(listId);
        setOpenList(res.list);
      } catch {
        setOpenList(null);
      }
    },
    [api, openList],
  );

  const removeFromList = React.useCallback(
    async (listId: number, itemId: number) => {
      try {
        const res = await api.removeFromList(listId, itemId);
        setOpenList(res.list);
        setLists((cur) =>
          cur.map((l) => (l.id === listId ? { ...l, itemCount: res.list.items.length } : l)),
        );
      } catch {
        // Откатывать нечего: локальное состояние не менялось до ответа.
      }
    },
    [api],
  );

  if (ready && !user) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>
          Войдите, чтобы видеть профиль, историю и сохранённое.
        </Text>
        <Link href="/login" asChild>
          <Pressable
            style={StyleSheet.flatten([styles.loginButton, focusLogin.ring])}
            hasTVPreferredFocus
            {...focusLogin.props}
          >
            <Text style={styles.loginText}>Войти</Text>
          </Pressable>
        </Link>
      </View>
    );
  }

  if (!ready || loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={tokens.color.accent} />
      </View>
    );
  }

  const counters: { label: string; value: number }[] = stats
    ? [
        { label: "Сохранённое", value: stats.favorites },
        { label: "Подборки", value: stats.lists },
        { label: "История", value: stats.history },
        { label: "Просмотрено", value: stats.watched },
        { label: "В процессе", value: stats.inProgress },
        { label: "Подписки", value: stats.subscriptions },
        { label: "Комментарии", value: stats.comments },
      ]
    : [];

  return (
    <ScrollView
      testID="profile-screen"
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.title}>{user?.name ?? "Профиль"}</Text>
      {user?.email && <Text style={styles.muted}>{user.email}</Text>}

      <View style={styles.counters}>
        {counters.map((c) => (
          <View key={c.label} style={styles.counter}>
            <Text style={styles.counterValue}>{c.value}</Text>
            <Text style={styles.counterLabel}>{c.label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>История просмотра</Text>
          {history.length > 0 && !confirmClear && (
            <Pressable
              testID="clear-history"
              style={styles.textButton}
              onPress={() => setConfirmClear(true)}
              accessibilityRole="button"
            >
              <Text style={styles.dangerText}>Очистить историю</Text>
            </Pressable>
          )}
        </View>

        {confirmClear && (
          <View style={styles.confirmBar} testID="clear-history-confirm">
            <Text style={styles.muted}>Удалить всю историю?</Text>
            <ConfirmButton
              testID="clear-history-yes"
              label="Очистить"
              danger
              onPress={() => void clearHistory()}
            />
            <ConfirmButton
              testID="clear-history-no"
              label="Отмена"
              onPress={() => setConfirmClear(false)}
            />
          </View>
        )}

        {history.length === 0 ? (
          <Text style={styles.muted}>История пуста.</Text>
        ) : (
          history.map((h) => (
            <HistoryRow
              key={h.mediaId}
              entry={h}
              onOpen={() => router.push(`/watch/${h.itemId}/${h.mediaId}`)}
              onDelete={() => void actions.removeHistoryEntry(h.mediaId)}
            />
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Сохранённое</Text>
        {favorites.length === 0 ? (
          <Text style={styles.muted}>Здесь появятся тайтлы, добавленные в сохранённое.</Text>
        ) : (
          <View style={styles.grid}>
            {favorites.map((f) => (
              <FavoriteCell
                key={f.itemId}
                fav={f}
                onRemove={() => void actions.removeFavorite(f.itemId)}
              />
            ))}
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Подборки</Text>
        <View style={styles.createRow}>
          <TextInput
            testID="list-title-input"
            style={styles.input}
            placeholder="Новая подборка"
            placeholderTextColor={tokens.color.textMuted}
            value={newListTitle}
            onChangeText={setNewListTitle}
            onSubmitEditing={() => void createList()}
            returnKeyType="done"
          />
          <CreateListButton onCreate={() => void createList()} disabled={!newListTitle.trim()} />
        </View>

        {lists.length === 0 ? (
          <Text style={styles.muted}>Подборок пока нет.</Text>
        ) : (
          lists.map((l) => (
            <ListRow
              key={l.id}
              list={l}
              detail={openList?.id === l.id ? openList : null}
              onToggle={() => void toggleList(l.id)}
              onDelete={() => void actions.deleteList(l.id)}
              onRemoveItem={(itemId) => void removeFromList(l.id, itemId)}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}

/** Строка истории: тап — в плеер, долгий тап или «✕» — удалить одну запись. */
function HistoryRow({
  entry,
  onOpen,
  onDelete,
}: {
  entry: HistoryEntryDto;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const focus = useTvFocus();
  const focusDel = useTvFocus();
  return (
    <View style={styles.histRow} testID="history-row">
      <Pressable
        style={StyleSheet.flatten([styles.histMain, focus.ring])}
        onPress={onOpen}
        onLongPress={onDelete}
        accessibilityRole="button"
        {...focus.props}
      >
        {entry.posterMedium ? (
          <Image source={{ uri: entry.posterMedium }} style={styles.histPoster} resizeMode="cover" />
        ) : (
          <View style={[styles.histPoster, styles.placeholder]}>
            <Text style={styles.placeholderText}>Зал.</Text>
          </View>
        )}
        <View style={styles.histBody}>
          <Text style={styles.histLabel} numberOfLines={1}>
            {historyLabel(entry)}
          </Text>
          <Text style={styles.muted} numberOfLines={1}>
            {entry.itemTitle}
          </Text>
          <View style={styles.progressTrack}>
            <View
              style={[styles.progressFill, { width: `${Math.min(1, entry.progress) * 100}%` }]}
            />
          </View>
          <Text style={styles.muted}>{formatRelativeTime(entry.updatedAt)}</Text>
        </View>
      </Pressable>
      <Pressable
        testID="history-delete"
        style={[styles.iconButton, focusDel.ring]}
        onPress={onDelete}
        accessibilityRole="button"
        accessibilityLabel="Удалить из истории"
        {...focusDel.props}
      >
        <Text style={styles.iconText}>✕</Text>
      </Pressable>
    </View>
  );
}

/** Плитка сохранённого: переход в тайтл и снятие с сохранённого. */
function FavoriteCell({ fav, onRemove }: { fav: FavoriteDto; onRemove: () => void }) {
  const focus = useTvFocus();
  const focusDel = useTvFocus();
  return (
    <View style={styles.cell} testID="favorite-cell">
      <Link href={`/item/${fav.itemId}`} asChild>
        <Pressable
          style={StyleSheet.flatten([styles.cellLink, focus.ring])}
          accessibilityRole="button"
          {...focus.props}
        >
          {fav.item.posterMedium ? (
            <Image
              source={{ uri: fav.item.posterMedium }}
              style={styles.cellPoster}
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.cellPoster, styles.placeholder]}>
              <Text style={styles.placeholderText}>Зал.</Text>
            </View>
          )}
          <Text style={styles.cellTitle} numberOfLines={2}>
            {fav.item.title}
          </Text>
        </Pressable>
      </Link>
      <Pressable
        testID="favorite-remove"
        style={[styles.iconButton, focusDel.ring]}
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel="Убрать из сохранённого"
        {...focusDel.props}
      >
        <Text style={styles.iconText}>✕</Text>
      </Pressable>
    </View>
  );
}

/** Кнопка создания подборки — отдельный компонент ради фокуса пульта. */
function CreateListButton({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  const focus = useTvFocus();
  return (
    <Pressable
      testID="list-create"
      style={[styles.createButton, disabled && styles.createOff, focus.ring]}
      disabled={disabled}
      onPress={onCreate}
      accessibilityRole="button"
      {...focus.props}
    >
      <Text style={styles.loginText}>Создать</Text>
    </Pressable>
  );
}

/** Строка подборки: раскрывается в список тайтлов, удаляется целиком. */
function ListRow({
  list,
  detail,
  onToggle,
  onDelete,
  onRemoveItem,
}: {
  list: UserListDto;
  detail: UserListDetailDto | null;
  onToggle: () => void;
  onDelete: () => void;
  onRemoveItem: (itemId: number) => void;
}) {
  const focusHead = useTvFocus();
  const focusDel = useTvFocus();
  return (
    <View style={styles.listRow} testID="list-row">
      <View style={styles.listHead}>
        <Pressable
          style={StyleSheet.flatten([styles.listTitleWrap, focusHead.ring])}
          onPress={onToggle}
          accessibilityRole="button"
          {...focusHead.props}
        >
          <Text style={styles.listTitle}>{list.title}</Text>
          <Text style={styles.muted}>
            {list.itemCount} шт. · {detail ? "свернуть" : "открыть"}
          </Text>
        </Pressable>
        <Pressable
          testID="list-delete"
          style={[styles.iconButton, focusDel.ring]}
          onPress={onDelete}
          accessibilityRole="button"
          accessibilityLabel="Удалить подборку"
          {...focusDel.props}
        >
          <Text style={styles.dangerText}>Удалить</Text>
        </Pressable>
      </View>

      {detail && (
        <View style={styles.listItems} testID="list-detail">
          {detail.items.length === 0 ? (
            <Text style={styles.muted}>Пусто.</Text>
          ) : (
            detail.items.map((it) => (
              <ListItemRow key={it.id} item={it} onRemove={() => onRemoveItem(it.id)} />
            ))
          )}
        </View>
      )}
    </View>
  );
}

function ListItemRow({ item, onRemove }: { item: ProfileItem; onRemove: () => void }) {
  const focus = useTvFocus();
  const focusDel = useTvFocus();
  return (
    <View style={styles.listItem}>
      <Link href={`/item/${item.id}`} asChild>
        <Pressable
          style={StyleSheet.flatten([styles.listItemLink, focus.ring])}
          accessibilityRole="button"
          {...focus.props}
        >
          <Text style={styles.histLabel} numberOfLines={1}>
            {item.title}
          </Text>
          {item.year != null && <Text style={styles.muted}>{item.year}</Text>}
        </Pressable>
      </Link>
      <Pressable
        testID="list-item-remove"
        style={[styles.iconButton, focusDel.ring]}
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel="Убрать из подборки"
        {...focusDel.props}
      >
        <Text style={styles.iconText}>✕</Text>
      </Pressable>
    </View>
  );
}

/** Кнопка подтверждения: общий вид, фокус пульта на каждой. */
function ConfirmButton({
  testID,
  label,
  danger = false,
  onPress,
}: {
  testID: string;
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const focus = useTvFocus();
  return (
    <Pressable
      testID={testID}
      style={[styles.confirmButton, focus.ring]}
      onPress={onPress}
      accessibilityRole="button"
      {...focus.props}
    >
      <Text style={danger ? styles.dangerText : styles.muted}>{label}</Text>
    </Pressable>
  );
}
