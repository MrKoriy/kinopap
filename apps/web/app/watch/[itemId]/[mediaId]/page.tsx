import { notFound } from "next/navigation";
import Link from "next/link";
import type { ItemDetail } from "@zal/api-client";
import { fetchItem, fetchMediaLinks } from "@/lib/api";
import { Player, type PlayerNext } from "@/components/player/player";

// Страница просмотра всегда свежая: media-links с baseKey из БД не кэшируются.
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
  const links = await fetchMediaLinks(Number(itemId), Number(mediaId));
  if (!item || !links) notFound();

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
      <Player
        links={links}
        title={item.title}
        next={nextEpisode(item, links.mediaId)}
      />

      {/* Панель быстрого запуска во внешнем плеере */}
      {links.files[0]?.urls.http && (
        <section className="mt-6 rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Просмотр во внешнем плеере</h3>
              <p className="mt-0.5 text-xs text-muted">
                Если в браузере нет звука (кодек AC3/Dolby) или хотите 4K HDR без перекодирования — откройте поток в IINA или VLC:
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`iina://weblink?url=${encodeURIComponent(links.files[0].urls.http)}`}
                className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition hover:bg-accent-hover"
              >
                Открыть в IINA (Mac)
              </a>
              <a
                href={`vlc://${links.files[0].urls.http}`}
                className="rounded-full border border-border bg-surface-elevated px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/10"
              >
                Открыть в VLC
              </a>
              <a
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(
                  `#EXTM3U\n#EXTINF:-1,${item.title}\n${links.files[0].urls.http}`,
                )}`}
                download={`${item.title}.m3u`}
                className="rounded-full border border-border bg-surface-elevated px-4 py-2 text-xs font-semibold text-white/90 transition hover:bg-white/10"
              >
                Скачать M3U
              </a>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
