import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";

/**
 * Точечный сброс ISR-кэша: воркер шлёт сюда теги тайтлов, которые реально
 * изменились (новые серии, обновлённые метаданные), — страница тайтла
 * перерисуется на следующем визите, не дожидаясь часового таймера.
 *
 *   POST /api/revalidate
 *   Authorization: Bearer <REVALIDATE_SECRET>
 *   { "tags": ["item:42", "catalog"] }
 *
 * Без REVALIDATE_SECRET в env маршрут выключен (404): открытый сброс кэша
 * позволил бы кому угодно гонять рендер страниц по кругу.
 */
const TAG_RE = /^(?:catalog|item:\d{1,10})$/;
const MAX_TAGS = 500;

function authorized(header: string | null, secret: string): boolean {
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) return new Response(null, { status: 404 });
  if (!authorized(request.headers.get("authorization"), secret)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  let tags: unknown;
  try {
    tags = ((await request.json()) as { tags?: unknown }).tags;
  } catch {
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    return Response.json({ ok: false, error: "bad_tags" }, { status: 400 });
  }
  const valid = [...new Set(tags.filter((t): t is string => typeof t === "string" && TAG_RE.test(t)))];
  // expire: 0 — запись протухает сразу: следующий визит получит свежие данные,
  // а не одну устаревшую отрисовку (как при профиле "max").
  for (const tag of valid) revalidateTag(tag, { expire: 0 });
  return Response.json({ ok: true, revalidated: valid.length });
}
