"use client";

/** Шапка сайта: логотип, навигация, состояние авторизации. */
import Link from "next/link";
import { useAuth } from "@/lib/auth";

export function Header() {
  const { user, logout } = useAuth();

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

        <div className="flex-1" />

        {user ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-white" data-testid="header-user">
              {user.name ?? user.email}
            </span>
            <button
              className="text-sm text-muted transition hover:text-white"
              onClick={() => void logout()}
              data-testid="logout-button"
            >
              Выйти
            </button>
          </div>
        ) : (
          <Link
            href="/login"
            className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-accent-hover"
            data-testid="login-link"
          >
            Войти
          </Link>
        )}
      </div>
    </header>
  );
}
