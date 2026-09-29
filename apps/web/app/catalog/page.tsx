import { ITEM_TYPE_TITLES, type ItemType } from "@zal/api-client";
import type { Metadata } from "next";
import Link from "next/link";
import { ItemCard } from "@/components/item-card";
import { type CatalogParams, fetchItems } from "@/lib/api";

export const revalidate = 30;

export const metadata: Metadata = {
  title: "Каталог — Зал",
  description:
    "Каталог закрытого стриминг-клуба «Зал»: фильмы, сериалы, аниме, концерты и документальное кино — с фильтрами по типу, году и рейтингу.",
};

const SORTS: { value: string; label: string }[] = [
  { value: "updated-", label: "Новое" },
  { value: "year-", label: "По году" },
  { value: "rating-", label: "По рейтингу" },
  { value: "views-", label: "Популярное" },
  { value: "title", label: "По алфавиту" },
];

/** Чип-ссылка фильтра: сохраняет остальные параметры. */
function Chip({
  active,
  params,
  label,
  testId,
}: {
  active: boolean;
  params: Record<string, string | undefined>;
  label: string;
  testId: string;
}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
  );
  return (
    <Link
      href={`/catalog${search.size ? `?${search.toString()}` : ""}`}
      className={`rounded-full px-4 py-1.5 text-sm transition ${
        active
          ? "bg-accent font-medium text-white"
          : "bg-surface-2 text-muted hover:text-white"
      }`}
      data-testid={testId}
    >
      {label}
    </Link>
  );
}

/** Каталог: фильтры по типу и сортировке, сетка, cursor-пагинация. */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pick = (k: string): string | undefined =>
    Array.isArray(sp[k]) ? sp[k]![0] : sp[k];

  const type = pick("type") as ItemType | undefined;
  const sort = pick("sort");
  const cursor = pick("cursor");
  const title = pick("title");

  const params: CatalogParams = { type, sort, cursor, title, limit: 24 };
  const page = await fetchItems(params);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="mb-6 text-3xl font-bold text-white">
        {title ? `Поиск: ${title}` : "Каталог"}
      </h1>

      {/* Тип контента */}
      <div className="mb-3 flex flex-wrap gap-2" data-testid="type-filters">
        <Chip
          active={!type}
          params={{ sort, title }}
          label="Всё"
          testId="type-all"
        />
        {Object.entries(ITEM_TYPE_TITLES).map(([id, label]) => (
          <Chip
            key={id}
            active={type === id}
            params={{ type: id, sort, title }}
            label={label}
            testId={`type-${id}`}
          />
        ))}
      </div>

      {/* Сортировка */}
      <div className="mb-8 flex flex-wrap gap-2" data-testid="sort-filters">
        {SORTS.map((s) => (
          <Chip
            key={s.value}
            active={(sort ?? "updated-") === s.value}
            params={{ type, sort: s.value, title }}
            label={s.label}
            testId={`sort-${s.value}`}
          />
        ))}
      </div>

      {page.items.length === 0 ? (
        <p className="py-16 text-center text-muted" data-testid="catalog-empty">
          Ничего не найдено.
        </p>
      ) : (
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
          data-testid="catalog-grid"
        >
          {page.items.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {page.nextCursor && (
        <div className="mt-10 flex justify-center">
          <Link
            href={`/catalog?${new URLSearchParams(
              Object.entries({ type, sort, title, cursor: page.nextCursor }).filter(
                ([, v]) => v !== undefined && v !== "",
              ) as [string, string][],
            ).toString()}`}
            className="rounded-full border border-border px-6 py-2.5 text-sm font-medium text-white transition hover:bg-surface-2"
            data-testid="load-more"
          >
            Показать ещё
          </Link>
        </div>
      )}
    </main>
  );
}
