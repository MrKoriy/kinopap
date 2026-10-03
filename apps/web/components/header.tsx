"use client";

/** Шапка сайта: логотип, навигация, состояние авторизации. */
import Image from "next/image";
import Link from "next/link";
import * as React from "react";
import { SearchBox } from "@/components/search-box";
import { useAuth } from "@/lib/auth";

export function Header() {
  const { user, api, logout } = useAuth();
  const [unread, setUnread] = React.useState(0);

  // Badge непросмотренных новинок — с 60с кэшем (раньше на каждый маунт/ререндер).
  const unreadCacheRef = React.useRef<{ at: number; value: number } | null>(null);
  React.useEffect(() => {
    if (!user) {
      setUnread(0);
      return;
    }
    const cached = unreadCacheRef.current;
    if (cached && Date.now() - cached.at < 60_000) {
      setUnread(cached.value);
      return;
    }
    let cancelled = false;
    api.getNewEpisodes().then(
      (res: { total: number }) => {
        if (cancelled) return;
        unreadCacheRef.current = { at: Date.now(), value: res.total };
        setUnread(res.total);
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
        <Link href="/" className="flex items-center gap-2 text-2xl font-bold tracking-tight text-white">
          <Image src="/logo.png" alt="" width={32} height={32} className="h-8 w-8" priority />
          kino<span className="text-accent">.</span>pap
        </Link>

        <nav className="flex gap-4 text-sm text-muted">
          <Link href="/" className="transition hover:text-white">
            Главная
          </Link>
          <Link href="/catalog" className="transition hover:text-white">
            Каталог
          </Link>
        </nav>

        <SearchBox />

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
