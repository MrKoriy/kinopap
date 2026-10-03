"use client";

/**
 * Поиск в шапке с подсказками по мере ввода: debounce 220 мс, отмена
 * устаревших запросов, стрелки/Enter/Esc. Enter без выбора — полная выдача
 * на /search (как раньше).
 */
import { ITEM_TYPE_TITLES, type ItemSummary } from "@zal/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { PosterImage } from "@/components/poster-image";
import { fetchSuggest } from "@/lib/api";
import { displayRating } from "@/lib/format";

const DEBOUNCE_MS = 220;

export function SearchBox() {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [items, setItems] = React.useState<ItemSummary[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [loading, setLoading] = React.useState(false);
  const boxRef = React.useRef<HTMLFormElement>(null);

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
    router.push(href);
  };

  const showDropdown = open && query.trim().length >= 2 && (items.length > 0 || !loading);

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
        className="w-40 rounded-full border border-border bg-surface-2 px-4 py-1.5 text-sm text-white outline-none transition focus:border-accent sm:w-64"
        type="search"
        placeholder="Поиск…"
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
                      onClick={() => setOpen(false)}
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
