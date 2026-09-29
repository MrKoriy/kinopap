import type { MetadataRoute } from "next";
import { fetchItems } from "@/lib/api";
import { absoluteUrl } from "@/lib/site";

// Карта сайта живёт ISR-жизнью: раз в час, не на каждый запрос.
export const revalidate = 3600;

/** Карта сайта: статические маршруты + карточки тайтлов (первые ~200). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), changeFrequency: "daily", priority: 1 },
    { url: absoluteUrl("/catalog"), changeFrequency: "daily", priority: 0.9 },
  ];

  // API принимает limit ≤ 100 — добираем до ~200 второй страницей по cursor.
  const first = await fetchItems({ limit: 100, sort: "updated-" });
  const second = first.nextCursor
    ? await fetchItems({ limit: 100, sort: "updated-", cursor: first.nextCursor })
    : null;
  const items = [...first.items, ...(second?.items ?? [])];

  return [
    ...staticRoutes,
    ...items.map(
      (item): MetadataRoute.Sitemap[number] => ({
        url: absoluteUrl(`/item/${item.id}`),
        lastModified: item.updatedAt,
        changeFrequency: "weekly",
        priority: 0.7,
      }),
    ),
  ];
}
