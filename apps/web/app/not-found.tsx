import Link from "next/link";

/** 404: тайтла/страницы нет — отличимо от «API умер» (это error.tsx). */
export default function NotFoundPage() {
  return (
    <main className="mx-auto flex max-w-7xl flex-col items-center justify-center gap-4 px-4 py-24">
      <h1 className="text-2xl font-bold text-white">Не нашлось</h1>
      <p className="text-muted" data-testid="not-found-message">
        Такой страницы или тайтла в kino.pap нет.
      </p>
      <Link
        href="/"
        className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-hover"
      >
        На главную
      </Link>
    </main>
  );
}
