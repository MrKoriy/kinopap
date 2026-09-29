"use client";

import type {
  FavoriteDto,
  HistoryEntryDto,
  ProfileStats,
  UserListDetailDto,
  UserListDto,
} from "@zal/api-client";
import { useProfileActions } from "@zal/shared/react";
import Link from "next/link";
/**
 * Личный кабинет: история просмотра, сохранённое и подборки. Всё персонально,
 * поэтому страница клиентская — данные тянутся по сессии из cookie. Гость
 * видит честный призыв войти, а не пустые таблицы.
 *
 * Здесь — данные и оптимистичные апдейты; вёрстка секций в ./sections.tsx.
 */
import * as React from "react";
import { useOptionalAuth } from "@/lib/auth";
import { formatMemberSince } from "@/lib/profile-format";
import { FavoritesSection, HistorySection, ListsSection } from "./sections";

/** Порядок и подписи счётчиков сводки. */
const STAT_ITEMS: { key: keyof ProfileStats; label: string }[] = [
  { key: "favorites", label: "Сохранённое" },
  { key: "lists", label: "Подборки" },
  { key: "history", label: "История" },
  { key: "watched", label: "Просмотрено" },
  { key: "inProgress", label: "В процессе" },
  { key: "subscriptions", label: "Подписки" },
  { key: "comments", label: "Комментарии" },
];

export default function ProfilePage() {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const user = auth?.user ?? null;

  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [stats, setStats] = React.useState<ProfileStats | null>(null);
  const [history, setHistory] = React.useState<HistoryEntryDto[]>([]);
  const [favorites, setFavorites] = React.useState<FavoriteDto[]>([]);
  const [lists, setLists] = React.useState<UserListDto[]>([]);
  const [openList, setOpenList] = React.useState<UserListDetailDto | null>(null);

  React.useEffect(() => {
    if (!api || !user) return;
    let cancelled = false;
    api.getProfileOverview().then(
      ({ profile }) => {
        if (cancelled) return;
        setStats(profile.stats);
        setHistory(profile.history);
        setFavorites(profile.favorites);
        setLists(profile.lists);
        setLoaded(true);
      },
      () => {
        if (cancelled) return;
        setFailed(true);
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, user]);

  // Общий цикл оптимистичных апдейтов (снимок → сеттеры → API → откат) —
  // хук из @zal/shared/react; сюда приходят только входы: клиент, ячейки
  // состояния и политика счётчиков. Веб при сбое счётчики возвращает.
  const actions = useProfileActions({
    api,
    state: { stats, history, favorites, lists, openList },
    setters: { setStats, setHistory, setFavorites, setLists, setOpenList },
    revertStatsOnFailure: true,
  });

  if (!user || !api) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-16 text-center" data-testid="profile-page">
        <h1 className="mb-4 text-3xl font-bold text-white">Личный кабинет</h1>
        <p className="mb-6 text-muted" data-testid="profile-login-hint">
          Войдите, чтобы видеть историю просмотра, сохранённое и свои подборки.
        </p>
        <Link
          href="/login"
          className="inline-flex rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-hover"
          data-testid="profile-login-link"
        >
          Войти
        </Link>
      </main>
    );
  }

  /* ---------- Оптимистичные апдейты: UI меняется сразу, при сбое — откат ---------- */

  const createList = async (input: {
    title: string;
    description: string | null;
    isPublic: boolean;
  }): Promise<boolean> => {
    if (!api) return false;
    try {
      const { list } = await api.createList(input);
      setLists((cur) => [list, ...cur]);
      setStats((s) => (s ? { ...s, lists: s.lists + 1 } : s));
      return true;
    } catch {
      return false;
    }
  };

  const openListDetail = async (listId: number) => {
    if (!api) return;
    try {
      const { list } = await api.getList(listId);
      setOpenList(list);
    } catch {
      // Не открылось — оставляем как было.
    }
  };

  const removeFromList = async (listId: number, itemId: number) => {
    if (!api) return;
    const prevOpen = openList;
    const prevLists = lists;
    setOpenList((cur) =>
      cur && cur.id === listId
        ? {
            ...cur,
            items: cur.items.filter((it) => it.id !== itemId),
            itemCount: Math.max(0, cur.itemCount - 1),
          }
        : cur,
    );
    setLists((cur) =>
      cur.map((l) =>
        l.id === listId ? { ...l, itemCount: Math.max(0, l.itemCount - 1) } : l,
      ),
    );
    try {
      await api.removeFromList(listId, itemId);
    } catch {
      setOpenList(prevOpen);
      setLists(prevLists);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8" data-testid="profile-page">
      {/* Шапка профиля */}
      <section className="mb-8">
        <h1 className="text-3xl font-bold text-white" data-testid="profile-name">
          {user.name ?? user.email}
        </h1>
        <p className="mt-1 text-sm text-muted">{user.email}</p>
        {user.createdAt && (
          <p className="mt-0.5 text-sm text-muted">
            В Зале с {formatMemberSince(user.createdAt)}
          </p>
        )}
      </section>

      {/* Счётчики */}
      <section
        className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7"
        data-testid="profile-stats"
      >
        {STAT_ITEMS.map(({ key, label }) => (
          <div
            key={key}
            className="rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3"
          >
            <div className="text-xl font-bold text-white">{stats?.[key] ?? 0}</div>
            <div className="text-xs text-muted">{label}</div>
          </div>
        ))}
      </section>

      {failed && (
        <p className="mb-8 rounded-[var(--radius-card)] border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
          Не удалось загрузить профиль. Обновите страницу позже.
        </p>
      )}

      <HistorySection
        history={history}
        loaded={loaded}
        onRemoveEntry={(entry) => void actions.removeHistoryEntry(entry.mediaId)}
        onClear={() => void actions.clearHistory()}
      />

      <FavoritesSection
        favorites={favorites}
        loaded={loaded}
        onRemove={(itemId) => void actions.removeFavorite(itemId)}
      />

      <ListsSection
        lists={lists}
        loaded={loaded}
        openList={openList}
        onOpenList={(listId) => void openListDetail(listId)}
        onCloseList={() => setOpenList(null)}
        onCreate={createList}
        onDelete={(listId) => void actions.deleteList(listId)}
        onRemoveItem={(listId, itemId) => void removeFromList(listId, itemId)}
      />
    </main>
  );
}
