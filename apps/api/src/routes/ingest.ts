import {
  type IngestJobStatusDto,
  ingestRequestSchema,
} from "@zal/api-client";
import {
  createIngestJob,
  type Db,
  getIngestJob,
  type IngestJobRow,
} from "@zal/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import type { IngestQueue } from "../ingest-queue";
import { notFound, parseOrThrow } from "../lib/http";
import { requireRole } from "../plugins/auth";

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

export function toIngestJobDto(row: IngestJobRow): IngestJobStatusDto {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    status: row.status as IngestJobStatusDto["status"],
    itemId: row.itemId,
    mediaId: row.mediaId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function ingestRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config; queue: IngestQueue },
): Promise<void> {
  const { db, queue } = deps;

  /**
   * Запуск ingest: создаём задачу и отправляем в очередь транскода.
   * Только owner/admin — ingest это административное действие.
   * Раньше запрещали только member: будущая роль получала бы права
   * молча. Теперь allow-list, как у инвайтов и discovery.
   */
  app.post(
    "/ingest",
    { preHandler: [app.authenticate, requireRole("owner", "admin")] },
    async (request, reply) => {
    const body = parseOrThrow(ingestRequestSchema, request.body);
    const row = await createIngestJob(db, {
      sourceType: body.source.type,
      sourceRef: body.source.ref,
    });
    await queue.enqueueIngest({
      kind: "ingest",
      jobId: row.id,
      source: body.source,
      item: body.item,
      ladders: body.ladders,
      episode: body.episode,
    });
    reply.code(202);
    return { job: toIngestJobDto(row) };
  });

  /** Статус ingest-задачи. */
  app.get("/ingest/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const row = await getIngestJob(db, id);
    if (!row) throw notFound(`Ingest job ${id} not found`);
    return { job: toIngestJobDto(row) };
  });
}
