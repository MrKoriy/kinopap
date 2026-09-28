"use client";

import type { UserListDto } from "@zal/api-client";
import { cn } from "@zal/ui";
import { Check, ListPlus, Plus } from "lucide-react";
import Link from "next/link";
/**
 * «В подборку» на странице тайтла: дропдаун со списком подборок пользователя,
 * чекбоксами и инлайн-созданием новой. Принадлежность тайтла подборке API
 * отдельным методом не отдаёт — выясняем из деталей каждой подборки.
 */
import * as React from "react";
import { useOptionalAuth } from "@/lib/auth";

export interface CollectionMenuProps {
  itemId: number;
  className?: string;
}

export function CollectionMenu({ itemId, className }: CollectionMenuProps) {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const user = auth?.user ?? null;

  const [open, setOpen] = React.useState(false);
  const [lists, setLists] = React.useState<UserListDto[]>([]);
  const [member, setMember] = React.useState<ReadonlySet<number>>(new Set());
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [newTitle, setNewTitle] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);

  // Клик вне меню закрывает дропдаун — иначе он «залипает» поверх страницы.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Открытие тянет подборки и их состав: чекбоксы должны отражать реальность.
  React.useEffect(() => {
    if (!open || !api || !user) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { items } = await api.listLists();
        const details = await Promise.all(
          items.map((l) => api.getList(l.id).catch(() => null)),
        );
        if (cancelled) return;
        setLists(items);
        const ids = new Set<number>();
        for (const d of details) {
          if (d?.list.items.some((it) => it.id === itemId)) ids.add(d.list.id);
        }
        setMember(ids);
      } catch {
        // Список недоступен — меню остаётся с пустым состоянием и формой.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, api, user, itemId]);

  const toggle = async (listId: number) => {
    if (!api || busy) return;
    const inList = member.has(listId);
    const prev = new Set(member);
    const bump = (delta: number) =>
      setLists((cur) =>
        cur.map((l) =>
          l.id === listId ? { ...l, itemCount: Math.max(0, l.itemCount + delta) } : l,
        ),
      );
    setMember((cur) => {
      const next = new Set(cur);
      if (inList) next.delete(listId);
      else next.add(listId);
      return next;
    });
    bump(inList ? -1 : 1);
    setBusy(true);
    try {
      if (inList) await api.removeFromList(listId, itemId);
      else await api.addToList(listId, itemId);
    } catch {
      setMember(prev);
      bump(inList ? 1 : -1);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const title = newTitle.trim();
    if (!api || !title || busy) return;
    setBusy(true);
    try {
      const { list } = await api.createList({ title, isPublic: false });
      const { list: detail } = await api.addToList(list.id, itemId);
      setLists((cur) => [detail, ...cur]);
      setMember((cur) => new Set(cur).add(detail.id));
      setNewTitle("");
    } catch {
      // Не удалось — оставляем введённое название, чтобы не терять ввод.
    } finally {
      setBusy(false);
    }
  };

  if (!user || !api) {
    return (
      <Link
        href="/login"
        className={cn(
          "inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20",
          className,
        )}
        title="Войдите, чтобы добавить в подборку"
        data-testid="collection-menu-login"
      >
        <ListPlus className="h-4 w-4" />В подборку
      </Link>
    );
  }

  return (
    <div className={cn("relative", className)} ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
        data-testid="collection-menu"
      >
        <ListPlus className="h-4 w-4" />В подборку
      </button>

      {open && (
        <div
          className="absolute right-0 z-20 mt-2 w-64 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-xl"
          data-testid="collection-menu-panel"
        >
          {loading ? (
            <p className="px-2 py-3 text-xs text-muted">Загрузка…</p>
          ) : lists.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted" data-testid="collection-menu-empty">
              Подборок пока нет
            </p>
          ) : (
            <ul>
              {lists.map((l) => (
                <li key={l.id}>
                  <label
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-white transition hover:bg-surface-2"
                    data-testid="collection-option"
                  >
                    <input
                      type="checkbox"
                      checked={member.has(l.id)}
                      onChange={() => void toggle(l.id)}
                      disabled={busy}
                      className="accent-accent"
                    />
                    <span className="flex-1 truncate">{l.title}</span>
                    {member.has(l.id) && <Check className="h-3.5 w-3.5 text-accent" />}
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createAndAdd();
                }
              }}
              placeholder="Новая подборка"
              className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 py-1.5 text-sm text-white outline-none transition focus:border-accent"
              data-testid="collection-new-input"
            />
            <button
              type="button"
              onClick={() => void createAndAdd()}
              disabled={!newTitle.trim() || busy}
              aria-label="Создать подборку"
              className="grid h-8 w-8 shrink-0 place-items-center rounded bg-accent text-white transition hover:bg-accent-hover disabled:opacity-50"
              data-testid="collection-new-submit"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
