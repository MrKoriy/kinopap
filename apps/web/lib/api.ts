/**
 * Доступ к API «Зал» из веба: обычный fetch + валидация ответов zod-схемами
 * из @zal/api-client. Работает и на сервере, и в браузере.
 *
 * Ошибки НЕ глотаются в рантайме: транспортный сбой/5xx/сломанный контракт
 * летит наверх — error boundary показывает «API недоступен», а не пустой
 * экран, неотличимый от «ничего не нашлось». Пустота — это 200 и [].
 * Исключение — production-build: ISR-страницы пререндерятся до старта API,
 * там деградируем в пусто, первый revalidate дорисует.
 */
import {
  type ItemDetail,
  type ItemPage,
  type ItemType,
  itemDetailSchema,
  itemPageSchema,
  type MediaLinks,
  mediaLinksSchema,
} from "@zal/api-client";

export const API_BASE =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_URL ?? "")
    : (process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001");

export type ShortcutKind = "fresh" | "hot" | "popular";

/** Ошибка доступа к API (сеть/5xx/сломанный контракт). 404 — отдельный случай. */
export class ApiUnavailableError extends Error {
  constructor(
    public readonly status: number,
    path: string,
  ) {
    super(`API ${path}: ${status}`);
    this.name = "ApiUnavailableError";
  }
}

/**
 * Без серверного кэша Next: данные ходят в API напрямую, иначе
 * протухшие media-links из прошлых сборок уезжают в плеер.
 */
async function getJson(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  } catch {
    throw new ApiUnavailableError(0, path);
  }
  if (!res.ok) throw new ApiUnavailableError(res.status, path);
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

/** Билд без API → fallback; рантайм → исключение наверх. */
async function softOnBuildPhase<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (process.env.NEXT_PHASE === "phase-production-build") return fallback;
    throw err;
  }
}

/** Список каталога: 200 и пусто — пустая страница; сбой — исключение. */
export async function fetchItems(params: CatalogParams = {}): Promise<ItemPage> {
  return softOnBuildPhase(
    async () => itemPageSchema.parse(await getJson(`/v1/items${qs(params)}`)),
    EMPTY_PAGE,
  );
}

export async function fetchShortcut(
  kind: ShortcutKind,
  limit = 12,
): Promise<ItemPage> {
  return softOnBuildPhase(
    async () => itemPageSchema.parse(await getJson(`/v1/items/${kind}${qs({ limit })}`)),
    EMPTY_PAGE,
  );
}

/** null — тайтла нет (404). Сбой сети/5xx — исключение, не «не найдено». */
export async function fetchItem(id: number): Promise<ItemDetail | null> {
  return softOnBuildPhase(
    async () => {
      try {
        return itemDetailSchema.parse(await getJson(`/v1/items/${id}`));
      } catch (err) {
        if (err instanceof ApiUnavailableError && err.status === 404) return null;
        throw err;
      }
    },
    null,
  );
}

/** Поиск с pg_trgm: title/director/cast. */
export async function fetchSearch(
  q: string,
  field?: "title" | "director" | "cast",
  limit = 24,
): Promise<ItemPage> {
  if (!q.trim()) return EMPTY_PAGE;
  return softOnBuildPhase(
    async () =>
      itemPageSchema.parse(
        await getJson(`/v1/items/search${qs({ q: q.trim(), field, limit })}`),
      ),
    EMPTY_PAGE,
  );
}

export async function fetchSimilar(id: number): Promise<ItemPage> {
  return softOnBuildPhase(
    async () => {
      try {
        return itemPageSchema.parse(await getJson(`/v1/items/${id}/similar`));
      } catch (err) {
        if (err instanceof ApiUnavailableError && err.status === 404) {
          return EMPTY_PAGE;
        }
        throw err;
      }
    },
    EMPTY_PAGE,
  );
}

/** null — пары item/media нет (404). Сбой — исключение. */
export async function fetchMediaLinks(
  itemId: number,
  mediaId: number,
): Promise<MediaLinks | null> {
  try {
    return mediaLinksSchema.parse(
      await getJson(`/v1/items/${itemId}/media-links${qs({ mid: mediaId })}`),
    );
  } catch (err) {
    if (err instanceof ApiUnavailableError && err.status === 404) return null;
    throw err;
  }
}
