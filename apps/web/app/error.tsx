"use client";

/** Error boundary роута: API недоступен или сломан контракт — говорим об этом. */
import Link from "next/link";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const apiDown = error.name === "ApiUnavailableError";
  return (
    <main className="mx-auto flex max-w-7xl flex-col items-center justify-center gap-4 px-4 py-24">
      <h1 className="text-2xl font-bold text-white">
        {apiDown ? "Сервис недоступен" : "Что-то сломалось"}
      </h1>
      <p className="max-w-md text-center text-muted" data-testid="error-message">
        {apiDown
          ? "Не удалось связаться с сервером «Зал». Проверьте соединение или зайдите чуть позже."
          : "Страница отрендерилась с ошибкой. Попробуйте ещё раз."}
      </p>
      <div className="flex gap-3">
        <button
        type="button"
          onClick={reset}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-hover"
        >
          Повторить
        </button>
        <Link
          href="/"
          className="rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-semibold text-white/80 transition hover:bg-white/10"
        >
          На главную
        </Link>
      </div>
    </main>
  );
}
