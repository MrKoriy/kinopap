/**
 * Курсор cursor-пагинации: base64url(JSON) с последней сортировочной парой
 * (значение + id), чтобы страницы не дублировались при равных значениях сортировки.
 * Кодек без зависимостей — btoa/atob есть и в Node, и в браузере.
 */
import { z } from "zod";
import { type SortDir, type SortField, sortDirSchema, sortFieldSchema } from "./catalog";

export const cursorSchema = z.object({
  s: sortFieldSchema,
  d: sortDirSchema,
  v: z.union([z.string(), z.number(), z.null()]),
  id: z.number().int().positive(),
});
export type CursorPayload = z.infer<typeof cursorSchema>;

function b64urlEncode(text: string): string {
  return btoa(encodeURIComponent(text))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(text: string): string {
  return decodeURIComponent(atob(text.replace(/-/g, "+").replace(/_/g, "/")));
}

export function encodeCursor(payload: CursorPayload): string {
  return b64urlEncode(JSON.stringify(cursorSchema.parse(payload)));
}

/** null на любом мусоре — кривой курсор не должен ронять запрос. */
export function decodeCursor(raw: string): CursorPayload | null {
  try {
    return cursorSchema.parse(JSON.parse(b64urlDecode(raw)));
  } catch {
    return null;
  }
}

export function makeCursor(
  sort: { field: SortField; dir: SortDir },
  value: string | number | null,
  id: number,
): string {
  return encodeCursor({ s: sort.field, d: sort.dir, v: value, id });
}
