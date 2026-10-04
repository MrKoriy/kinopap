"use client";

/**
 * Поиск в шапке с подсказками по мере ввода: debounce 150 мс, отмена
 * устаревших запросов, стрелки/Enter/Esc. Enter без выбора — полная выдача
 * на /search (как раньше). Хоткеи «/» и Ctrl/⌘+K — фокус в поиск; пустое
 * поле показывает историю запросов (localStorage).
 */
import { ITEM_TYPE_TITLES, type ItemSummary } from "@zal/api-client";
import { Clock, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { PosterImage } from "@/components/poster-image";
import { fetchSuggest } from "@/lib/api";
import { displayRating } from "@/lib/format";

const DEBOUNCE_MS = 150;
const HISTORY_KEY = "zal:search-history";
const HISTORY_MAX = 8;

export function readSearchHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

export function pushSearchHistory(q: string): string[] {
  const query = q.trim();
  if (query.length < 2) return readSearchHistory();
  const next = [query, ...readSearchHistory().filter((x) => x.toLowerCase() !== query.toLowerCase())].slice(
    0,
    HISTORY_MAX,
  );
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // приватный режим — без истории
  }
  return next;
}

/** Хоткей поиска не должен срабатывать, пока человек печатает в другом поле. */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

export function SearchBox() {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [items, setItems] = React.useState<ItemSummary[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [loading, setLoading] = React.useState(false);
  const boxRef = React.useRef<HTMLFormElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [history, setHistory] = React.useState<string[]>([]);

  React.useEffect(() => {
    setHistory(readSearchHistory());
    const onKey = (e: KeyboardEvent) => {
      const combo = (e.key === "k" || e.key === "K" || e.key === "л" || e.key === "Л") && (e.ctrlKey || e.metaKey);
      if (combo || (e.key === "/" && !isTypingTarget(e.target))) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setItems([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      fetchSuggest(q, { signal: ctrl.signal }).then(
        (page) => {
          setItems(page.items);
          setActive(-1);
          setLoading(false);
        },
        () => {
          if (!ctrl.signal.aborted) setLoading(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setHistory(pushSearchHistory(query));
    inputRef.current?.blur();
    router.push(href);
  };

  const showDropdown = open && query.trim().length >= 2 && (items.length > 0 || !loading);
  const showHistory = open && query.trim().length === 0 && history.length > 0;

  return (
    <form
      ref={boxRef}
      className="relative ml-auto flex items-center gap-2"
      data-testid="search-form"
      onSubmit={(e) => {
        e.preventDefault();
        const picked = active >= 0 ? items[active] : undefined;
        if (picked) return go(`/item/${picked.id}`);
        const q = query.trim();
        if (q) go(`/search?q=${encodeURIComponent(q)}`);
      }}
    >
      <input
        ref={inputRef}
        className="w-40 rounded-full border border-border bg-surface-2 px-4 py-1.5 text-sm text-white outline-none transition focus:border-accent sm:w-64"
        type="search"
        placeholder="Поиск…  /"
        aria-keyshortcuts="/ Control+K"
        value={query}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, -1));
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        data-testid="search-input"
      />
      <button
        type="submit"
        className="rounded-full bg-surface-2 px-4 py-1.5 text-sm text-muted transition hover:text-white"
        data-testid="search-submit"
      >
        Найти
      </button>

      {showHistory && (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-[22rem] max-w-[90vw] overflow-hidden rounded-xl border border-border bg-surface shadow-popover"
          data-testid="search-history"
        >
          <div className="flex items-center justify-between px-4 pb-1 pt-3 text-xs uppercase tracking-wide text-muted">
            <span>Недавние запросы</span>
            <button
              type="button"
              className="normal-case tracking-normal hover:text-white"
              onClick={() => {
                try {
                  localStorage.removeItem(HISTORY_KEY);
                } catch {}
                setHistory([]);
              }}
            >
              Очистить
            </button>
          </div>
          <ul className="pb-2">
            {history.map((h) => (
              <li key={h} className="group flex items-center">
                <Link
                  href={`/search?q=${encodeURIComponent(h)}`}
                  onClick={() => {
                    setOpen(false);
                    setQuery(h);
                    setHistory(pushSearchHistory(h));
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2 text-sm text-white/90 transition hover:bg-surface-2"
                >
                  <Clock className="h-4 w-4 shrink-0 text-muted" />
                  <span className="truncate">{h}</span>
                </Link>
                <button
                  type="button"
                  aria-label={`Удалить «${h}» из истории`}
                  className="mr-2 rounded p-1 text-muted opacity-0 transition hover:text-white group-hover:opacity-100"
                  onClick={() => {
                    const next = readSearchHistory().filter((x) => x !== h);
                    try {
                      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
                    } catch {}
                    setHistory(next);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showDropdown && (
        <div
          id="search-suggest"
          className="absolute right-0 top-full z-50 mt-2 w-[22rem] max-w-[90vw] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/60"
          data-testid="search-suggest"
        >
          {items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">Ничего не нашлось — нажмите Enter для полного поиска</p>
          ) : (
            <ul>
              {items.map((it, i) => {
                const poster = it.posters.small ?? it.posters.medium ?? it.posters.big;
                const rating = displayRating(it);
                return (
                  <li key={it.id}>
                    <Link
                      href={`/item/${it.id}`}
                      onClick={() => {
                        setOpen(false);
                        setHistory(pushSearchHistory(query));
                      }}
                      onMouseEnter={() => setActive(i)}
                      aria-current={i === active ? "true" : undefined}
                      className={`flex items-center gap-3 px-3 py-2 transition ${i === active ? "bg-surface-2" : ""}`}
                    >
                      <div className="relative h-14 w-10 shrink-0 overflow-hidden rounded bg-surface-2">
                        {poster && <PosterImage src={poster} alt="" fill sizes="40px" className="object-cover" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-white">{it.title}</p>
                        <p className="truncate text-xs text-muted">
                          {[it.year, ITEM_TYPE_TITLES[it.type], it.originalTitle !== it.title ? it.originalTitle : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      {rating != null && rating > 0 && (
                        <span className="shrink-0 text-xs font-semibold text-emerald-400">{rating.toFixed(1)}</span>
                      )}
                    </Link>
                  </li>
                );
              })}
              <li>
                <Link
                  href={`/search?q=${encodeURIComponent(query.trim())}`}
                  onClick={() => setOpen(false)}
                  className="block border-t border-border px-4 py-2 text-center text-xs text-muted transition hover:text-white"
                >
                  Все результаты →
                </Link>
              </li>
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
