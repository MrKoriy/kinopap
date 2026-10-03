import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { fetchItem } from "@/lib/api";
import { episodeGroups } from "@/lib/player-logic";
import { WatchClient } from "./watch-client";

// Страница просмотра всегда свежая: item рендерим сразу, media-links
// клиент тянет сам (zero-storage резолв может занимать до ~10 секунд).
export const dynamic = "force-dynamic";

/** Плеер не индексируем: контент стриминга за логином. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ itemId: string; mediaId: string }>;
}): Promise<Metadata> {
  const { itemId } = await params;
  const item = await fetchItem(Number(itemId));
  return {
    title: `${item?.title ?? "Просмотр"} — смотреть — kino.pap`,
    robots: { index: false },
  };
}

/** Страница просмотра: плеер с выбором серии и переходом к следующей. */
export default async function WatchPage({
  params,
}: {
  params: Promise<{ itemId: string; mediaId: string }>;
}) {
  const { itemId, mediaId } = await params;
  const item = await fetchItem(Number(itemId));
  if (!item) notFound();
  // Карточку влили в другую (склейка дублей) — постоянный редирект.
  if (item.id !== Number(itemId)) permanentRedirect(`/item/${item.id}`);

  // Список серий строится здесь и уходит в плеер целиком: и меню выбора, и
  // «следующая серия» выводятся из него, поэтому разойтись не могут.
  const groups = episodeGroups(item);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4">
        <Link
          href={`/item/${item.id}`}
          className="text-sm text-muted transition hover:text-white"
          data-testid="back-to-item"
        >
          ← {item.title}
        </Link>
      </div>
      <WatchClient item={item} mediaId={Number(mediaId)} episodeGroups={groups} />
    </main>
  );
}
