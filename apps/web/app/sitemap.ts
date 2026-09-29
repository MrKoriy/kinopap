import type { MetadataRoute } from "next";
import { fetchItems } from "@/lib/api";

// Карта сайта живёт ISR-жизнью: раз в час, не на каждый запрос.
export const revalidate = 3600;

// База из env; без неё — относительные URL (см. app/robots.ts).
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "";

/** Карта сайта: статические маршруты + карточки тайтлов (первые ~200). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/catalog`, changeFrequency: "daily", priority: 0.9 },
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
        url: `${SITE_URL}/item/${item.id}`,
        lastModified: item.updatedAt,
        changeFrequency: "weekly",
        priority: 0.7,
      }),
    ),
  ];
}
