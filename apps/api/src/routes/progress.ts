/**
 * Прогресс просмотра: резюме с любого устройства, лента «продолжить».
 * Профиль — дефолтный (переключение профилей придёт в фазе 4).
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { progressPutSchema, type ProgressDto } from "@zal/api-client";
import {
  getDefaultProfile,
  getProgress,
  listProgress,
  media,
  upsertProgress,
  type Db,
  type ProgressRow,
} from "@zal/db";
import type { Config } from "../config";
import { notFound, parseOrThrow } from "../lib/http";

const idParamsSchema = z.object({ mediaId: z.coerce.number().int().positive() });

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
    const profile = await getDefaultProfile(db, request.user.sub);
    const rows = await listProgress(db, profile.id);
    return { items: rows.map(toProgressDto) };
  });

  /** Прогресс по media (для резюме при открытии плеера). */
  app.get("/progress/:mediaId", { preHandler: app.authenticate }, async (request) => {
    const { mediaId } = parseOrThrow(idParamsSchema, request.params);
    const profile = await getDefaultProfile(db, request.user.sub);
    const row = await getProgress(db, profile.id, mediaId);
    return { progress: row ? toProgressDto(row) : null };
  });

  /** Сохранить позицию (плеер шлёт каждые ~10 секунд и на паузе). */
  app.put("/progress/:mediaId", { preHandler: app.authenticate }, async (request) => {
    const { mediaId } = parseOrThrow(idParamsSchema, request.params);
    const body = parseOrThrow(progressPutSchema, request.body);

    const mediaRows = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
    if (!mediaRows[0]) throw notFound(`Media ${mediaId} not found`);

    const profile = await getDefaultProfile(db, request.user.sub);
    const row = await upsertProgress(db, {
      profileId: profile.id,
      itemId: mediaRows[0].itemId,
      mediaId,
      positionSeconds: body.positionSeconds,
      durationSeconds: body.durationSeconds,
    });
    return { progress: toProgressDto(row) };
  });
}
