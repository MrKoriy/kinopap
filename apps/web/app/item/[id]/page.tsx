import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ItemDetailView } from "@/components/item-detail";
import { ItemRail } from "@/components/item-rail";
import { RailSkeleton } from "@/components/skeletons";
import { fetchItem, fetchSimilar } from "@/lib/api";

export const revalidate = 30;

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
