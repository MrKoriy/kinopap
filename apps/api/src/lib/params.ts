import { z } from "zod";

/** Общий параметр пути: положительный int. Было 5 копий по роутам. */
export const positiveIntParam = z.coerce.number().int().positive();

/** `:id` — карточка, комментарии, голоса, ingest-задача и т.д. */
export const idParamsSchema = z.object({ id: positiveIntParam });

/** `:mediaId` — прогресс (у media свой ключ параметра, не `id`). */
export const mediaIdParamsSchema = z.object({ mediaId: positiveIntParam });
