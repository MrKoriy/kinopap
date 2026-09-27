import { Suspense } from "react";
import { HeroCarousel } from "@/components/hero-carousel";
import { ItemRail } from "@/components/item-rail";
import { HeroSkeleton, RailSkeleton } from "@/components/skeletons";
import { fetchShortcut, type ShortcutKind } from "@/lib/api";

export const revalidate = 30;

/** Лента, деградировавшая в честную ошибку, а не в «пусто». */
async function RailOrError({
  kind,
  title,
  href,
}: {
  kind: ShortcutKind;
  title: string;
  href: string;
}) {
  try {
    const page = await fetchShortcut(kind, 12);
    return <ItemRail title={title} items={page.items} href={href} />;
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

/** Главная: hero-карусель + ленты fresh/hot/popular. */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <Suspense fallback={<HeroSkeleton />}>
        <Hero />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <RailOrError kind="fresh" title="Свежее" href="/catalog?sort=updated-" />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <RailOrError kind="hot" title="В тренде" href="/catalog?sort=views-" />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <RailOrError kind="popular" title="Популярное" href="/catalog?sort=rating-" />
      </Suspense>
    </main>
  );
}
