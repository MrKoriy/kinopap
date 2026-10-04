import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ItemDetailView } from "@/components/item-detail";
import { fetchItem, fetchSimilar } from "@/lib/api";
import { isSeriesLike, itemJsonLd, ogImages, serializeJsonLd } from "@/lib/seo";

// Страховочный интервал ISR; свежесть даёт точечный revalidateTag из воркера.
export const revalidate = 3600;

/** Сюжет для description: обрезаем ~200 символов по границе слова. */
function truncatePlot(plot: string, max = 200): string {
  if (plot.length <= max) return plot;
  const cut = plot.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

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
  // Бэкдроп 16:9 — соцсети режут превью именно так; постер — фолбэк.
  const images = ogImages(item);

  return {
    title,
    description,
    alternates: { canonical: `/item/${item.id}` },
    openGraph: {
      title,
      description,
      type: isSeriesLike(item) ? "video.tv_show" : "video.movie",
      images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: images?.map((i) => i.url),
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
  const [item, similar] = await Promise.all([
    fetchItem(Number(id)),
    fetchSimilar(Number(id)).catch(() => ({ items: [] })),
  ]);
  if (!item) notFound();
  // Карточку влили в другую (склейка дублей) — постоянный редирект.
  if (item.id !== Number(id)) permanentRedirect(`/item/${item.id}`);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD по рецепту Next — «<» экранирован в serializeJsonLd.
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(itemJsonLd(item)) }}
      />
      <ItemDetailView item={item} similar={similar.items} />
    </main>
  );
}
