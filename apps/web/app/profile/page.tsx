"use client";

import type {
  FavoriteDto,
  HistoryEntryDto,
  ProfileStats,
  UserListDetailDto,
  UserListDto,
} from "@zal/api-client";
import { Film, ListVideo, Trash2, X } from "lucide-react";
import Link from "next/link";
/**
 * Личный кабинет: история просмотра, сохранённое и подборки. Всё персонально,
 * поэтому страница клиентская — данные тянутся по сессии из cookie. Гость
 * видит честный призыв войти, а не пустые таблицы.
 */
import * as React from "react";
import { PosterImage } from "@/components/poster-image";
import { useOptionalAuth } from "@/lib/auth";
import {
  formatMemberSince,
  formatRelativeTime,
  historyPositionLabel,
  pluralRu,
} from "@/lib/profile-format";

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

function PosterThumb({ src, alt }: { src: string | null; alt: string }) {
  return (
    <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded bg-surface-2">
      {src ? (
        <PosterImage src={src} alt={alt} className="h-full w-full object-cover" sizes="44px" />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <Film className="h-5 w-5 text-white/30" />
        </div>
      )}
    </div>
  );
}

/** Карточка «Сохранённого»: миниатюра + снятие закладки. */
function FavoriteCard({
  favorite,
  onRemove,
}: {
  favorite: FavoriteDto;
  onRemove: (itemId: number) => void;
}) {
  const { item } = favorite;
  const [imgError, setImgError] = React.useState(false);
  const poster = !imgError ? item.posterMedium : null;

  return (
    <div className="group relative" data-testid="favorite-card">
      <Link
        href={`/item/${item.id}`}
        className="block overflow-hidden rounded-[var(--radius-card)]"
      >
        <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface-2">
          {poster ? (
            <PosterImage
              src={poster}
              alt={item.title}
              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
              sizes="(max-width: 640px) 50vw, 16vw"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-3 text-center">
              <Film className="mb-2 h-7 w-7 text-white/30" />
              <span className="line-clamp-2 text-sm font-semibold text-white/90">
                {item.title}
              </span>
            </div>
          )}
          {item.rating > 0 && (
            <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">
              {item.rating.toFixed(1)}
            </span>
          )}
        </div>
        <p className="mt-2 truncate text-sm text-white">{item.title}</p>
        {item.year && <p className="text-xs text-muted">{item.year}</p>}
      </Link>
      <button
        type="button"
        onClick={() => onRemove(item.id)}
        aria-label="Убрать из сохранённого"
        className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
        data-testid="favorite-remove"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

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

  const [confirmClear, setConfirmClear] = React.useState(false);
  const [openList, setOpenList] = React.useState<UserListDetailDto | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState({ title: "", description: "", isPublic: false });

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

  const removeHistory = async (entry: HistoryEntryDto) => {
    if (!api) return;
    const prevHistory = history;
    const prevStats = stats;
    setHistory((cur) => cur.filter((h) => h.mediaId !== entry.mediaId));
    setStats((s) => (s ? { ...s, history: Math.max(0, s.history - 1) } : s));
    try {
      await api.deleteHistoryEntry(entry.mediaId);
    } catch {
      setHistory(prevHistory);
      setStats(prevStats);
    }
  };

  const clearHistory = async () => {
    if (!api) return;
    const prevHistory = history;
    const prevStats = stats;
    setConfirmClear(false);
    setHistory([]);
    setStats((s) => (s ? { ...s, history: 0 } : s));
    try {
      await api.clearHistory();
    } catch {
      setHistory(prevHistory);
      setStats(prevStats);
    }
  };

  const removeFavorite = async (itemId: number) => {
    if (!api) return;
    const prev = favorites;
    setFavorites((cur) => cur.filter((f) => f.itemId !== itemId));
    setStats((s) => (s ? { ...s, favorites: Math.max(0, s.favorites - 1) } : s));
    try {
      await api.removeFavorite(itemId);
    } catch {
      setFavorites(prev);
      setStats((s) => (s ? { ...s, favorites: s.favorites + 1 } : s));
    }
  };

  const createList = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api) return;
    const title = form.title.trim();
    if (!title) return;
    try {
      const { list } = await api.createList({
        title,
        description: form.description.trim() || null,
        isPublic: form.isPublic,
      });
      setLists((cur) => [list, ...cur]);
      setStats((s) => (s ? { ...s, lists: s.lists + 1 } : s));
      setForm({ title: "", description: "", isPublic: false });
      setCreating(false);
    } catch {
      // Оставляем форму открытой — пользователь повторит попытку.
    }
  };

  const deleteList = async (listId: number) => {
    if (!api) return;
    const prev = lists;
    setLists((cur) => cur.filter((l) => l.id !== listId));
    setStats((s) => (s ? { ...s, lists: Math.max(0, s.lists - 1) } : s));
    if (openList?.id === listId) setOpenList(null);
    try {
      await api.deleteList(listId);
    } catch {
      setLists(prev);
      setStats((s) => (s ? { ...s, lists: s.lists + 1 } : s));
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

      {/* История просмотра */}
      <section className="mb-10" data-testid="history-section">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold text-white">История просмотра</h2>
          {history.length > 0 &&
            (confirmClear ? (
              <span className="flex items-center gap-3 text-sm">
                <span className="text-muted">Очистить всю историю?</span>
                <button
                  type="button"
                  onClick={() => void clearHistory()}
                  className="font-medium text-red-400 transition hover:text-red-300"
                  data-testid="history-clear-confirm"
                >
                  Да, очистить
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="text-muted transition hover:text-white"
                  data-testid="history-clear-cancel"
                >
                  Отмена
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="text-sm text-muted transition hover:text-white"
                data-testid="history-clear"
              >
                Очистить историю
              </button>
            ))}
        </div>

        {loaded && history.length === 0 && (
          <p className="text-sm text-muted" data-testid="history-empty">
            История пуста. Начните смотреть — записи появятся здесь.
          </p>
        )}

        <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
          {history.map((entry) => (
            <li
              key={entry.mediaId}
              className="flex items-center gap-4 px-4 py-3"
              data-testid="history-row"
            >
              <Link
                href={`/watch/${entry.itemId}/${entry.mediaId}`}
                className="flex min-w-0 flex-1 items-center gap-4"
              >
                <PosterThumb src={entry.posterMedium} alt={entry.itemTitle} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">
                    {entry.itemTitle}
                  </p>
                  {historyPositionLabel(entry) && (
                    <p className="truncate text-xs text-accent">
                      {historyPositionLabel(entry)}
                    </p>
                  )}
                  <div className="mt-1.5 h-1 w-full max-w-xs overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${Math.min(1, Math.max(0, entry.progress)) * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {formatRelativeTime(entry.updatedAt)}
                  </p>
                </div>
              </Link>
              <button
                type="button"
                onClick={() => void removeHistory(entry)}
                aria-label="Удалить из истории"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-red-400"
                data-testid="history-delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Сохранённое */}
      <section className="mb-10" data-testid="favorites-section">
        <h2 className="mb-4 text-xl font-semibold text-white">Сохранённое</h2>
        {loaded && favorites.length === 0 && (
          <p className="text-sm text-muted" data-testid="favorites-empty">
            Сохранённого нет. Нажмите на закладку у тайтла, чтобы добавить.
          </p>
        )}
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6"
          data-testid="favorites-grid"
        >
          {favorites.map((favorite) => (
            <FavoriteCard
              key={favorite.itemId}
              favorite={favorite}
              onRemove={(id) => void removeFavorite(id)}
            />
          ))}
        </div>
      </section>

      {/* Подборки */}
      <section className="mb-10" data-testid="lists-section">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-xl font-semibold text-white">Подборки</h2>
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="rounded-full bg-surface-2 px-4 py-1.5 text-sm text-white transition hover:bg-surface-hover"
            data-testid="list-create"
          >
            Новая подборка
          </button>
        </div>

        {creating && (
          <form
            onSubmit={(e) => void createList(e)}
            className="mb-4 flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-4"
            data-testid="list-create-form"
          >
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Название"
              className="rounded border border-border bg-surface-2 px-3 py-2 text-sm text-white outline-none transition focus:border-accent"
              data-testid="list-create-title"
            />
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Описание (необязательно)"
              className="rounded border border-border bg-surface-2 px-3 py-2 text-sm text-white outline-none transition focus:border-accent"
              data-testid="list-create-description"
            />
            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={form.isPublic}
                onChange={(e) => setForm((f) => ({ ...f, isPublic: e.target.checked }))}
                className="accent-accent"
                data-testid="list-create-public"
              />
              Публичная
            </label>
            <button
              type="submit"
              disabled={!form.title.trim()}
              className="w-fit rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
              data-testid="list-create-submit"
            >
              Создать
            </button>
          </form>
        )}

        {loaded && lists.length === 0 && !creating && (
          <p className="text-sm text-muted" data-testid="lists-empty">
            Подборок пока нет. Создайте первую.
          </p>
        )}

        <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
          {lists.map((list) => (
            <li
              key={list.id}
              className="flex items-center gap-4 px-4 py-3"
              data-testid="list-row"
            >
              <button
                type="button"
                onClick={() => void openListDetail(list.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <ListVideo className="h-5 w-5 shrink-0 text-muted" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-white">
                    {list.title}
                  </span>
                  <span className="text-xs text-muted">
                    {list.itemCount}{" "}
                    {pluralRu(list.itemCount, "тайтл", "тайтла", "тайтлов")} ·{" "}
                    {list.isPublic ? "публичная" : "приватная"}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => void deleteList(list.id)}
                aria-label={`Удалить подборку ${list.title}`}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-red-400"
                data-testid="list-delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>

        {openList && (
          <div
            className="mt-4 rounded-[var(--radius-card)] border border-border bg-surface p-4"
            data-testid="list-detail"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold text-white">{openList.title}</h3>
              <button
                type="button"
                onClick={() => setOpenList(null)}
                className="text-sm text-muted transition hover:text-white"
                data-testid="list-detail-close"
              >
                Закрыть
              </button>
            </div>
            {openList.items.length === 0 ? (
              <p className="text-sm text-muted">В подборке пока нет тайтлов.</p>
            ) : (
              <ul className="divide-y divide-border">
                {openList.items.map((it) => (
                  <li
                    key={it.id}
                    className="flex items-center gap-4 py-2"
                    data-testid="list-detail-item"
                  >
                    <Link
                      href={`/item/${it.id}`}
                      className="min-w-0 flex-1 truncate text-sm text-white transition hover:text-accent"
                    >
                      {it.title}
                      {it.year ? <span className="text-muted"> ({it.year})</span> : null}
                    </Link>
                    <button
                      type="button"
                      onClick={() => void removeFromList(openList.id, it.id)}
                      aria-label={`Убрать ${it.title} из подборки`}
                      className="text-sm text-muted transition hover:text-red-400"
                      data-testid="list-item-remove"
                    >
                      Убрать
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
