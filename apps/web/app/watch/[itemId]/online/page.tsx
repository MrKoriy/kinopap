import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { OnlinePlayer } from "@/components/online-player";
import { fetchItem } from "@/lib/api";
import { episodeGroups } from "@/lib/player-logic";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ itemId: string }> }): Promise<Metadata> {
  const { itemId } = await params;
  const item = await fetchItem(Number(itemId));
  return { title: `${item?.title ?? "Просмотр"} — онлайн — kino.pap`, robots: { index: false } };
}

/** Онлайн-плеер балансера: статический сегмент важнее [mediaId]. */
export default async function OnlineWatchPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await fetchItem(Number(itemId));
  if (!item) notFound();
  if (item.id !== Number(itemId)) permanentRedirect(`/watch/${item.id}/online`);

  // «Через торрент» — как кнопка «Смотреть» на странице тайтла: первый файл
  // или серия, иначе id тайтла (резолв без хранения).
  const firstMedia = item.media?.[0]?.id ?? episodeGroups(item)[0]?.episodes[0]?.mediaId ?? item.id;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4">
        <Link href={`/item/${item.id}`} className="text-sm text-muted transition hover:text-white" data-testid="back-to-item">
          ← {item.title}
        </Link>
      </div>
      <OnlinePlayer itemId={item.id} torrentHref={`/watch/${item.id}/${firstMedia}`} />
    </main>
  );
}
