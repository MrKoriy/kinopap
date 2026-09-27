import { Suspense } from "react";
import { fetchShortcut, type ShortcutKind } from "@/lib/api";
import { HeroCarousel } from "@/components/hero-carousel";
import { ItemRail } from "@/components/item-rail";
import { HeroSkeleton, RailSkeleton } from "@/components/skeletons";

export const revalidate = 30;

/** Hero-карусель: верхняя полоса свежего. */
async function Hero() {
  const fresh = await fetchShortcut("fresh", 5);
  return <HeroCarousel items={fresh.items} />;
}

/** Лента секции; стримится по мере готовности — со скелетоном до ответа. */
async function Rail({
  kind,
  title,
  href,
}: {
  kind: ShortcutKind;
  title: string;
  href: string;
}) {
  const page = await fetchShortcut(kind, 12);
  return <ItemRail title={title} items={page.items} href={href} />;
}

/** Главная: hero-карусель + ленты fresh/hot/popular. */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <Suspense fallback={<HeroSkeleton />}>
        <Hero />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <Rail kind="fresh" title="Свежее" href="/catalog?sort=updated-" />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <Rail kind="hot" title="В тренде" href="/catalog?sort=views-" />
      </Suspense>
      <Suspense fallback={<RailSkeleton />}>
        <Rail kind="popular" title="Популярное" href="/catalog?sort=rating-" />
      </Suspense>
    </main>
  );
}
