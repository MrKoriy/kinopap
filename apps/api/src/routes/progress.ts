/**
 * Прогресс просмотра: резюме с любого устройства, лента «продолжить».
 * Профиль — дефолтный (переключение профилей придёт в фазе 4).
 */

import { type ProgressDto, progressPutSchema } from "@zal/api-client";
import {
  type Db,
  getProgress,
  listProgress,
  media,
  type ProgressRow,
  upsertProgress,
} from "@zal/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config";
import { notFound, parseOrThrow } from "../lib/http";
import { mediaIdParamsSchema } from "../lib/params";
import { requireProfileId } from "../plugins/auth";

export function toProgressDto(row: ProgressRow): ProgressDto {
  return {
    mediaId: row.mediaId,
    itemId: row.itemId,
    positionSeconds: row.positionSeconds,
    durationSeconds: row.durationSeconds,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function progressRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config },
): Promise<void> {
  const { db } = deps;

  /** Лента «продолжить просмотр». */
  app.get("/progress", { preHandler: app.authenticate }, async (request) => {
    const profileId = await requireProfileId(db, request);
    const rows = await listProgress(db, profileId);
    return { items: rows.map(toProgressDto) };
  });

  /** Прогресс по media (для резюме при открытии плеера). */
  app.get("/progress/:mediaId", { preHandler: app.authenticate }, async (request) => {
    const { mediaId } = parseOrThrow(mediaIdParamsSchema, request.params);
    const profileId = await requireProfileId(db, request);
    const row = await getProgress(db, profileId, mediaId);
    return { progress: row ? toProgressDto(row) : null };
  });

  /** Сохранить позицию (плеер шлёт каждые ~10 секунд и на паузе). */
  app.put(
    "/progress/:mediaId",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request) => {
    const { mediaId } = parseOrThrow(mediaIdParamsSchema, request.params);
    const body = parseOrThrow(progressPutSchema, request.body);

    const mediaRows = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
    if (!mediaRows[0]) throw notFound(`Media ${mediaId} not found`);

    const profileId = await requireProfileId(db, request);
    const row = await upsertProgress(db, {
      profileId: profileId,
      itemId: mediaRows[0].itemId,
      mediaId,
      positionSeconds: body.positionSeconds,
      durationSeconds: body.durationSeconds,
    });
    return { progress: toProgressDto(row) };
  });
}
