import { ITEM_TYPE_TITLES, type ItemType } from "@zal/api-client";
import type { Metadata } from "next";
import Link from "next/link";
import { CatalogGrid } from "@/components/catalog-grid";
import { fetchCountries, fetchGenres, fetchItems } from "@/lib/api";

export const revalidate = 30;

export const metadata: Metadata = {
  title: "Каталог — kino.pap",
  description:
    "Каталог kino.pap: фильмы, сериалы, аниме и документальное кино — с фильтрами по типу, году и рейтингу.",
};

const SORTS: { value: string; label: string }[] = [
  { value: "updated-", label: "Новое" },
  { value: "year-", label: "По году" },
  { value: "rating-", label: "По рейтингу" },
  { value: "views-", label: "Популярное" },
  { value: "title", label: "По алфавиту" },
];

/** Годы: конкретные свежие + декадами (формат парсит parseYearRange API). */
const YEARS: { value: string; label: string }[] = [
  { value: "2026", label: "2026" },
  { value: "2025", label: "2025" },
  { value: "2024", label: "2024" },
  { value: "2023", label: "2023" },
  { value: "2022", label: "2022" },
  { value: "2021", label: "2021" },
  { value: "2020", label: "2020" },
  { value: "2010-2019", label: "2010-е" },
  { value: "2000-2009", label: "2000-е" },
  { value: "1990-1999", label: "90-е" },
];

const RATINGS: { value: string; label: string }[] = [
  { value: "6", label: "6+" },
  { value: "7", label: "7+" },
  { value: "8", label: "8+" },
];

/** Страны в чипах — самые частые в каталоге; остальные доступны ссылкой ?country=. */
const TOP_COUNTRIES = ["Россия", "США", "Япония", "Южная Корея", "Великобритания", "Франция", "Китай", "Индия", "Германия", "Испания"];

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
  const genre = pick("genre");
  const year = pick("year");
  const rating = pick("rating");
  const country = pick("country");

  const [page, genres, allCountries] = await Promise.all([
    fetchItems({ type, sort, cursor, title, genre, year, rating, country, limit: 24 }),
    fetchGenres(type),
    fetchCountries(),
  ]);
  const countries = TOP_COUNTRIES.flatMap((t) => allCountries.filter((c) => c.title === t));
  // Общая база ссылок чипов: каждый чип меняет один параметр, остальные сохраняет.
  const base = { type, sort, title, genre, year, rating, country };

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="mb-6 text-3xl font-bold text-white">
        {title ? `Поиск: ${title}` : "Каталог"}
      </h1>

      {/* Тип контента */}
      <div className="mb-3 flex flex-wrap gap-2" data-testid="type-filters">
        <Chip
          active={!type}
          params={{ ...base, type: undefined }}
          label="Всё"
          testId="type-all"
        />
        {Object.entries(ITEM_TYPE_TITLES).map(([id, label]) => (
          <Chip
            key={id}
            active={type === id}
            params={{ ...base, type: id, genre: undefined }}
            label={label}
            testId={`type-${id}`}
          />
        ))}
      </div>

      {/* Сортировка */}
      <div className="mb-3 flex flex-wrap gap-2" data-testid="sort-filters">
        {SORTS.map((s) => (
          <Chip
            key={s.value}
            active={(sort ?? "updated-") === s.value}
            params={{ ...base, sort: s.value }}
            label={s.label}
            testId={`sort-${s.value}`}
          />
        ))}
      </div>

      {/* Жанры: id жанра в ?genre= (CSV на стороне API). Смена типа сбрасывает жанр —
          id из другого раздела каталога молча ничего не отфильтруют. */}
      {genres.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2" data-testid="genre-filters">
          <Chip
            active={!genre}
            params={{ ...base, genre: undefined }}
            label="Все жанры"
            testId="genre-all"
          />
          {genres.slice(0, 14).map((g) => (
            <Chip
              key={g.id}
              active={genre === String(g.id)}
              params={{ ...base, genre: String(g.id) }}
              label={g.title}
              testId={`genre-${g.id}`}
            />
          ))}
        </div>
      )}

      {/* Годы */}
      <div className="mb-3 flex flex-wrap gap-2" data-testid="year-filters">
        <Chip
          active={!year}
          params={{ ...base, year: undefined }}
          label="Все годы"
          testId="year-all"
        />
        {YEARS.map((y) => (
          <Chip
            key={y.value}
            active={year === y.value}
            params={{ ...base, year: y.value }}
            label={y.label}
            testId={`year-${y.value}`}
          />
        ))}
      </div>

      {/* Рейтинг и страна */}
      <div className="mb-8 flex flex-wrap gap-2" data-testid="extra-filters">
        <Chip active={!rating} params={{ ...base, rating: undefined }} label="Любой рейтинг" testId="rating-all" />
        {RATINGS.map((r) => (
          <Chip
            key={r.value}
            active={rating === r.value}
            params={{ ...base, rating: r.value }}
            label={`★ ${r.label}`}
            testId={`rating-${r.value}`}
          />
        ))}
        {countries.length > 0 && <span className="mx-1 w-px self-stretch bg-border" />}
        {countries.length > 0 && (
          <Chip active={!country} params={{ ...base, country: undefined }} label="Все страны" testId="country-all" />
        )}
        {countries.map((c) => (
          <Chip
            key={c.id}
            active={country === String(c.id)}
            params={{ ...base, country: String(c.id) }}
            label={c.title}
            testId={`country-${c.id}`}
          />
        ))}
      </div>

      <CatalogGrid
        initialItems={page.items}
        initialCursor={page.nextCursor}
        baseParams={{ type, sort, title, genre, year, rating, country, limit: 24 }}
      />
    </main>
  );
}
