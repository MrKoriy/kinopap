import { Suspense } from "react";
import { ContinueWatching } from "@/components/continue-watching";
import { HeroCarousel } from "@/components/hero-carousel";
import { ItemRail } from "@/components/item-rail";
import { HeroSkeleton, RailSkeleton } from "@/components/skeletons";
import { type CatalogParams, fetchItems, fetchShortcut, type ShortcutKind } from "@/lib/api";

export const revalidate = 30;

/** Лента, деградировавшая в честную ошибку, а не в «пусто». */
async function RailOrError({
  kind,
  params,
  title,
  href,
  ranked = false,
  limit = 12,
}: {
  kind?: ShortcutKind;
  /** Вместо shortcut — выборка каталога (тип + сортировка). */
  params?: CatalogParams;
  title: string;
  href: string;
  ranked?: boolean;
  limit?: number;
}) {
  try {
    const page = kind ? await fetchShortcut(kind, limit) : await fetchItems({ ...params, limit });
    return <ItemRail title={title} items={page.items} href={href} ranked={ranked} />;
  } catch {
    return (
      <section>
        <h2 className="mb-4 text-lg font-semibold text-white">{title}</h2>
        <p className="rounded-[var(--radius-card)] border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
          Лента недоступна: не удалось связаться с сервером.
        </p>
      </section>
    );
  }
}

/** Hero-карусель: верхняя полоса свежего. */
async function Hero() {
  try {
    const fresh = await fetchShortcut("fresh", 5);
    return <HeroCarousel items={fresh.items} />;
  } catch {
    return (
      <p className="rounded-[var(--radius-card)] border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
        Лента недоступна: не удалось связаться с сервером.
      </p>
    );
  }
}

/** Главная: hero-карусель, «Продолжить», Топ-10, свежее и ленты по типам. */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <Suspense fallback={<HeroSkeleton />}>
        <Hero />
      </Suspense>
      <ContinueWatching />
      <Suspense fallback={<RailSkeleton />}>
        <RailOrError kind="hot" title="Топ-10 сегодня" href="/catalog?sort=views-" ranked limit={10} />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <RailOrError kind="fresh" title="Свежее" href="/catalog?sort=updated-" />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <RailOrError params={{ type: "movie", sort: "views-" }} title="Фильмы" href="/catalog?type=movie&sort=views-" />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <RailOrError params={{ type: "serial", sort: "views-" }} title="Сериалы" href="/catalog?type=serial&sort=views-" />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <RailOrError params={{ type: "anime", sort: "views-" }} title="Аниме" href="/catalog?type=anime&sort=views-" />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <RailOrError kind="popular" title="Высокий рейтинг" href="/catalog?sort=rating-" />
      </Suspense>
    </main>
  );
}
