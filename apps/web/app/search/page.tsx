import { fetchSearch } from "@/lib/api";
import { ItemCard } from "@/components/item-card";

export const revalidate = 0;

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
