import type { ItemDetail } from "@zal/api-client";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { PlayerNext } from "@/components/player/player";
import { fetchItem } from "@/lib/api";
import { WatchClient } from "./watch-client";

// Страница просмотра всегда свежая: item рендерим сразу, media-links
// клиент тянет сам (zero-storage резолв может занимать до ~10 секунд).
export const dynamic = "force-dynamic";

/** Медиа id всех эпизодов сериала в порядке просмотра. */
function episodeOrder(item: ItemDetail): { mediaId: number; label: string }[] {
  const out: { mediaId: number; label: string }[] = [];
  for (const season of item.seasons ?? []) {
    for (const ep of season.episodes) {
      if (ep.mediaId != null) {
        out.push({
          mediaId: ep.mediaId,
          label: `S${season.number}E${ep.number}${ep.title ? ` · ${ep.title}` : ""}`,
        });
      }
    }
  }
  return out;
}

function nextEpisode(item: ItemDetail, mediaId: number): PlayerNext | null {
  const order = episodeOrder(item);
  const idx = order.findIndex((e) => e.mediaId === mediaId);
  if (idx < 0 || idx + 1 >= order.length) return null;
  return order[idx + 1]!;
}

/** Страница просмотра: плеер + навигация по эпизодам. */
export default async function WatchPage({
  params,
}: {
  params: Promise<{ itemId: string; mediaId: string }>;
}) {
  const { itemId, mediaId } = await params;
  const item = await fetchItem(Number(itemId));
  if (!item) notFound();

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
      <WatchClient
        item={item}
        mediaId={Number(mediaId)}
        next={nextEpisode(item, Number(mediaId))}
      />
    </main>
  );
}
