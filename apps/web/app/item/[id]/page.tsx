import type { ItemType } from "@zal/api-client";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ItemDetailView } from "@/components/item-detail";
import { ItemRail } from "@/components/item-rail";
import { RailSkeleton } from "@/components/skeletons";
import { fetchItem, fetchSimilar } from "@/lib/api";

export const revalidate = 30;

/** Сюжет для description: обрезаем ~200 символов по границе слова. */
function truncatePlot(plot: string, max = 200): string {
  if (plot.length <= max) return plot;
  const cut = plot.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Сериальные типы → video.tv.show, остальные → video.movie. */
const SERIAL_TYPES: ReadonlySet<ItemType> = new Set([
  "serial",
  "docuserial",
  "tvshow",
  "anime",
]);

/** Метаданные тайтла: тот же fetchItem (ISR-кэш общий со страницей). */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const item = await fetchItem(Number(id));
  if (!item) return {};

  const title = `${item.title}${item.year ? ` (${item.year})` : ""} — kino.pap`;
  const description = item.plot
    ? truncatePlot(item.plot)
    : "Страница тайтла в kino.pap.";
  const poster = item.posters.big ?? item.posters.medium;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: SERIAL_TYPES.has(item.type) ? "video.tv_show" : "video.movie",
      images: poster ? [{ url: poster }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: poster ? [{ url: poster }] : undefined,
    },
  };
}

/** Страница тайтла: описание, сезоны/эпизоды, похожее. */
export default async function ItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const item = await fetchItem(Number(id));
  if (!item) notFound();

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <ItemDetailView item={item} />
      <div className="mt-12">
        <Suspense fallback={<RailSkeleton />}>
          <Similar itemId={item.id} />
        </Suspense>
      </div>
    </main>
  );
}

async function Similar({ itemId }: { itemId: number }) {
  const similar = await fetchSimilar(itemId);
  if (similar.items.length === 0) return null;
  return <ItemRail title="Похожее" items={similar.items} />;
}
