"use client";

/** Шапка сайта: логотип, навигация, состояние авторизации. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { useAuth } from "@/lib/auth";

export function Header() {
  const { user, api, logout } = useAuth();
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [unread, setUnread] = React.useState(0);

  // Badge непросмотренных новинок по подпискам.
  React.useEffect(() => {
    if (!user) {
      setUnread(0);
      return;
    }
    let cancelled = false;
    api.getNewEpisodes().then(
      (res: { total: number }) => {
        if (!cancelled) setUnread(res.total);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [user, api]);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4">
        <Link href="/" className="text-2xl font-bold tracking-tight text-white">
          Зал<span className="text-accent">.</span>
        </Link>

        <nav className="flex gap-4 text-sm text-muted">
          <Link href="/" className="transition hover:text-white">
            Главная
          </Link>
          <Link href="/catalog" className="transition hover:text-white">
            Каталог
          </Link>
        </nav>

        <form
          className="ml-auto flex items-center gap-2"
          data-testid="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            const q = query.trim();
            if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
          }}
        >
          <input
            className="w-40 rounded-full border border-border bg-surface-2 px-4 py-1.5 text-sm text-white outline-none transition focus:border-accent sm:w-56"
            type="search"
            placeholder="Поиск…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="search-input"
          />
          <button
            type="submit"
            className="rounded-full bg-surface-2 px-4 py-1.5 text-sm text-muted transition hover:text-white"
            data-testid="search-submit"
          >
            Найти
          </button>
        </form>

        {user ? (
          <div className="flex items-center gap-3">
            <Link
              href="/subscriptions"
              className="relative text-sm text-muted transition hover:text-white"
              data-testid="subs-link"
            >
              Подписки
              {unread > 0 && (
                <span
                  className="absolute -right-3 -top-2 rounded-full bg-accent px-1.5 text-xs font-semibold text-white"
                  data-testid="subs-badge"
                >
                  {unread}
                </span>
              )}
            </Link>
            <Link
              href="/profile"
              className="text-sm text-white transition hover:text-accent"
              data-testid="header-user"
            >
              {user.name ?? user.email}
            </Link>
            <button
        type="button"
              className="text-sm text-muted transition hover:text-white"
              onClick={() => void logout()}
              data-testid="logout-button"
            >
              Выйти
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Link
              href="/profile"
              className="text-sm text-muted transition hover:text-white"
              data-testid="profile-link"
            >
              Профиль
            </Link>
            <Link
              href="/login"
              className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-accent-hover"
              data-testid="login-link"
            >
              Войти
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
