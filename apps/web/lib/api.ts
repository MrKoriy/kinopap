/**
 * Доступ к API «Зал» из веба: обычный fetch + валидация ответов zod-схемами
 * из @zal/api-client. Работает и на сервере, и в браузере.
 */
import {
  itemDetailSchema,
  itemPageSchema,
  mediaLinksSchema,
  type ItemDetail,
  type ItemPage,
  type ItemType,
  type MediaLinks,
} from "@zal/api-client";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export type ShortcutKind = "fresh" | "hot" | "popular";

/**
 * Без серверного кэша Next: данные ходят в API напрямую, иначе
 * протухшие media-links из прошлых сборок уезжают в плеер.
 */
async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  if (!entries.length) return "";
  const search = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
  return `?${search.toString()}`;
}

export type CatalogParams = {
  type?: ItemType;
  title?: string;
  genre?: string;
  country?: string;
  year?: string;
  letter?: string;
  actor?: string;
  director?: string;
  sort?: string;
  limit?: number;
  cursor?: string;
};

const EMPTY_PAGE: ItemPage = { items: [], nextCursor: null };

/**
 * Списки устойчивы к недоступному API: при сборке и при падении бэкенда
 * возвращаем пустую страницу (ISR перечеркнёт через revalidate).
 */
export async function fetchItems(params: CatalogParams = {}): Promise<ItemPage> {
  try {
    return itemPageSchema.parse(await getJson(`/v1/items${qs(params)}`));
  } catch {
    return EMPTY_PAGE;
  }
}

export async function fetchShortcut(
  kind: ShortcutKind,
  limit = 12,
): Promise<ItemPage> {
  try {
    return itemPageSchema.parse(await getJson(`/v1/items/${kind}${qs({ limit })}`));
  } catch {
    return EMPTY_PAGE;
  }
}

export async function fetchItem(id: number): Promise<ItemDetail | null> {
  try {
    return itemDetailSchema.parse(await getJson(`/v1/items/${id}`));
  } catch {
    return null;
  }
}

export async function fetchSimilar(id: number): Promise<ItemPage> {
  try {
    return itemPageSchema.parse(await getJson(`/v1/items/${id}/similar`));
  } catch {
    return EMPTY_PAGE;
  }
}

export async function fetchMediaLinks(
  itemId: number,
  mediaId: number,
): Promise<MediaLinks | null> {
  try {
    return mediaLinksSchema.parse(
      await getJson(`/v1/items/${itemId}/media-links${qs({ mid: mediaId })}`),
    );
  } catch {
    return null;
  }
}
