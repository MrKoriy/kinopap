"use client";

/**
 * Секции личного кабинета: история, сохранённое, подборки. Вынесены из
 * page.tsx — страница держала 570 строк, где данные, оптимистичные
 * апдейты и вёрстка трёх независимых секций были перемешаны. Здесь только
 * вёрстка и локальное UI-состояние (подтверждения, форма); данные и
 * API-действия остаются в странице.
 */
import type { FavoriteDto, HistoryEntryDto, UserListDetailDto, UserListDto } from "@zal/api-client";
import { historyPositionLabel } from "@zal/shared";
import { Film, ListVideo, Trash2, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { PosterImage } from "@/components/poster-image";
import { formatRelativeTime, pluralRu } from "@/lib/profile-format";

export function PosterThumb({ src, alt }: { src: string | null; alt: string }) {
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

export interface HistorySectionProps {
  history: HistoryEntryDto[];
  loaded: boolean;
  onRemoveEntry: (entry: HistoryEntryDto) => void;
  /** Вызывается после подтверждения в UI секции. */
  onClear: () => void;
}

export function HistorySection({ history, loaded, onRemoveEntry, onClear }: HistorySectionProps) {
  const [confirmClear, setConfirmClear] = React.useState(false);

  return (
    <section className="mb-10" data-testid="history-section">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold text-white">История просмотра</h2>
        {history.length > 0 &&
          (confirmClear ? (
            <span className="flex items-center gap-3 text-sm">
              <span className="text-muted">Очистить всю историю?</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmClear(false);
                  onClear();
                }}
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
              onClick={() => onRemoveEntry(entry)}
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
  );
}

export function FavoritesSection({
  favorites,
  loaded,
  onRemove,
}: {
  favorites: FavoriteDto[];
  loaded: boolean;
  onRemove: (itemId: number) => void;
}) {
  return (
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
          <FavoriteCard key={favorite.itemId} favorite={favorite} onRemove={onRemove} />
        ))}
      </div>
    </section>
  );
}

export interface ListsSectionProps {
  lists: UserListDto[];
  loaded: boolean;
  openList: UserListDetailDto | null;
  onOpenList: (listId: number) => void;
  onCloseList: () => void;
  /** Успех создания — секция закрывает форму. */
  onCreate: (input: { title: string; description: string | null; isPublic: boolean }) => Promise<boolean>;
  onDelete: (listId: number) => void;
  onRemoveItem: (listId: number, itemId: number) => void;
}

export function ListsSection({
  lists,
  loaded,
  openList,
  onOpenList,
  onCloseList,
  onCreate,
  onDelete,
  onRemoveItem,
}: ListsSectionProps) {
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState({ title: "", description: "", isPublic: false });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = form.title.trim();
    if (!title) return;
    const ok = await onCreate({
      title,
      description: form.description.trim() || null,
      isPublic: form.isPublic,
    });
    if (ok) {
      setForm({ title: "", description: "", isPublic: false });
      setCreating(false);
    }
    // Неудача — оставляем форму открытой, пользователь повторит попытку.
  };

  return (
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
          onSubmit={(e) => void submit(e)}
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
              onClick={() => onOpenList(list.id)}
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
              onClick={() => onDelete(list.id)}
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
              onClick={onCloseList}
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
                    onClick={() => onRemoveItem(openList.id, it.id)}
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
  );
}
