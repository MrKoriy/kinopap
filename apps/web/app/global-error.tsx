"use client";

/** Глобальный boundary: падение даже layout — не серый экран Next по умолчанию. */
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="ru">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
        <h1 className="text-2xl font-bold text-white">kino.pap временно недоступен</h1>
        <p className="text-muted">Произошла ошибка уровня приложения.</p>
        <button
        type="button"
          onClick={reset}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white"
        >
          Повторить
        </button>
      </body>
    </html>
  );
}
