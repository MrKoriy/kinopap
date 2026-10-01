import type { Metadata } from "next";
import Link from "next/link";
import { ItemCard } from "@/components/item-card";
import { fetchSearch } from "@/lib/api";

const FIELDS = [
  { id: "", title: "Везде" },
  { id: "title", title: "Название" },
  { id: "director", title: "Режиссёр" },
  { id: "cast", title: "Актёры" },
] as const;

export const revalidate = 0;

// Без запроса страница пустая, с запросом — бесконечные варианты URL: не индексируем.
export const metadata: Metadata = {
  title: "Поиск — kino.pap",
  robots: { index: false },
};

/** Результаты поиска: title/director/cast через pg_trgm на бэкенде. */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; field?: string }>;
}) {
  const { q = "", field } = await searchParams;
  const query = q.trim();
  const fieldParam =
    field === "director" || field === "cast" || field === "title" ? field : undefined;
  const page = await fetchSearch(query, fieldParam);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-wrap gap-2" data-testid="search-fields">
        {FIELDS.map((f) => (
          <Link
            key={f.id}
            href={`/search?q=${encodeURIComponent(query)}${f.id ? `&field=${f.id}` : ""}`}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              (fieldParam ?? "") === f.id
                ? "bg-accent text-white"
                : "bg-surface-2 text-muted hover:text-white"
            }`}
            data-testid={`search-field-${f.id || "all"}`}
          >
            {f.title}
          </Link>
        ))}
      </div>

      <h1 className="mb-6 text-2xl font-bold text-white" data-testid="search-title">
        {query ? (
          <>
            Поиск: <span className="text-accent">{query}</span>
          </>
        ) : (
          "Поиск"
        )}
      </h1>

      {!query && (
        <p className="py-16 text-center text-muted" data-testid="search-empty">
          Введите запрос в строке поиска сверху.
        </p>
      )}

      {query && page.items.length === 0 && (
        <p className="py-16 text-center text-muted" data-testid="search-empty">
          Ничего не нашлось. Попробуйте другой запрос.
        </p>
      )}

      {page.items.length > 0 && (
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6"
          data-testid="search-results"
        >
          {page.items.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </main>
  );
}
