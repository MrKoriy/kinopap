import { ITEM_TYPE_TITLES, type ItemType } from "@zal/api-client";
import { X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type * as React from "react";
import { CatalogGrid } from "@/components/catalog-grid";
import { ChipLink } from "@/components/ui/chip";
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

/** Ссылка каталога с параметрами (пустые выкидываются). */
function catalogHref(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
  );
  return `/catalog${search.size ? `?${search.toString()}` : ""}`;
}

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
  return (
    <ChipLink href={catalogHref(params)} active={active} data-testid={testId} scroll={false}>
      {label}
    </ChipLink>
  );
}

/** Ряд чипов одной группы: подпись слева, горизонтальная прокрутка без переноса. */
function FilterRow({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-muted">{label}</span>
      <div
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid={testId}
      >
        {children}
      </div>
    </div>
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
  const playable = pick("playable") === "1" ? "1" : undefined;

  const [page, genres, allCountries] = await Promise.all([
    fetchItems({ type, sort, cursor, title, genre, year, rating, country, playable, limit: 24 }),
    fetchGenres(type),
    fetchCountries(),
  ]);
  const countries = TOP_COUNTRIES.flatMap((t) => allCountries.filter((c) => c.title === t));
  // Общая база ссылок чипов: каждый чип меняет один параметр, остальные сохраняет.
  const base = { type, sort, title, genre, year, rating, country, playable };
  // Активные фильтры — снимаемые чипы в липкой панели.
  const activeFilters = [
    genre && { key: "genre", label: genres.find((g) => String(g.id) === genre)?.title ?? "Жанр" },
    year && { key: "year", label: YEARS.find((y) => y.value === year)?.label ?? year },
    rating && { key: "rating", label: `★ ${rating}+` },
    country && { key: "country", label: allCountries.find((c) => String(c.id) === country)?.title ?? "Страна" },
    playable && { key: "playable", label: "Можно смотреть" },
  ].filter(Boolean) as Array<{ key: keyof typeof base; label: string }>;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="mb-4 text-3xl font-bold text-white">
        {title ? `Поиск: ${title}` : "Каталог"}
      </h1>

      {/* Липкая панель: тип, сортировка и снимаемые чипы активных фильтров. */}
      <div className="glass sticky top-16 z-40 -mx-4 mb-4 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div
            className="flex min-w-0 gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="type-filters"
          >
            <Chip active={!type} params={{ ...base, type: undefined }} label="Всё" testId="type-all" />
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
          <div
            className="ml-auto flex min-w-0 gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="sort-filters"
          >
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
        </div>
        {activeFilters.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="active-filters">
            {activeFilters.map((f) => (
              <Link
                key={f.key}
                href={catalogHref({ ...base, [f.key]: undefined })}
                scroll={false}
                className="inline-flex h-7 items-center gap-1 rounded-full bg-accent-soft px-3 text-xs font-medium text-white ring-1 ring-accent/40 transition hover:bg-accent/30"
                aria-label={`Убрать фильтр: ${f.label}`}
              >
                {f.label} <X className="h-3.5 w-3.5" />
              </Link>
            ))}
            <Link href={catalogHref({ type, sort, title })} scroll={false} className="text-xs text-muted hover:text-white">
              Сбросить всё
            </Link>
          </div>
        )}
      </div>

      {/* Группы фильтров: по ряду на группу. Смена типа сбрасывает жанр —
          id из другого раздела каталога молча ничего не отфильтруют. */}
      <div className="mb-8 space-y-2">
        {genres.length > 0 && (
          <FilterRow label="Жанр" testId="genre-filters">
            <Chip active={!genre} params={{ ...base, genre: undefined }} label="Все" testId="genre-all" />
            {genres.slice(0, 20).map((g) => (
              <Chip
                key={g.id}
                active={genre === String(g.id)}
                params={{ ...base, genre: String(g.id) }}
                label={g.title}
                testId={`genre-${g.id}`}
              />
            ))}
          </FilterRow>
        )}
        <FilterRow label="Год" testId="year-filters">
          <Chip active={!year} params={{ ...base, year: undefined }} label="Все" testId="year-all" />
          {YEARS.map((y) => (
            <Chip
              key={y.value}
              active={year === y.value}
              params={{ ...base, year: y.value }}
              label={y.label}
              testId={`year-${y.value}`}
            />
          ))}
        </FilterRow>
        <FilterRow label="Ещё" testId="extra-filters">
          <Chip
            active={playable === "1"}
            params={{ ...base, playable: playable ? undefined : "1" }}
            label="▶ Можно смотреть"
            testId="playable-toggle"
          />
          <span className="mx-1 w-px shrink-0 self-stretch bg-border" />
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
          {countries.length > 0 && <span className="mx-1 w-px shrink-0 self-stretch bg-border" />}
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
        </FilterRow>
      </div>

      <CatalogGrid
        initialItems={page.items}
        initialCursor={page.nextCursor}
        baseParams={{ type, sort, title, genre, year, rating, country, playable, limit: 24 }}
      />
    </main>
  );
}
