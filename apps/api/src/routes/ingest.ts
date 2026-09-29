import {
  type IngestJobStatusDto,
  ingestRequestSchema,
} from "@zal/api-client";
import {
  createIngestJob,
  type Db,
  findActiveIngestJob,
  getIngestJob,
  type IngestJobRow,
  isUniqueViolationError,
} from "@zal/db";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config";
import type { IngestQueue } from "../ingest-queue";
import { conflict, notFound, parseOrThrow } from "../lib/http";
import { idParamsSchema } from "../lib/params";
import { requireRole } from "../plugins/auth";

/** DTO статуса задачи. `error` — сырая строка воркера (пути, ffmpeg):
 * её видят только owner/admin, остальным — generic «failed», поле
 * остаётся в ответе (контракт DTO) без подробностей. */
export function toIngestJobDto(
  row: IngestJobRow,
  opts: { includeError?: boolean } = {},
): IngestJobStatusDto {
  const error =
    opts.includeError === false && row.error != null ? "failed" : row.error;
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    status: row.status as IngestJobStatusDto["status"],
    itemId: row.itemId,
    mediaId: row.mediaId,
    error,
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
    let row: IngestJobRow;
    try {
      row = await createIngestJob(db, {
        sourceType: body.source.type,
        sourceRef: body.source.ref,
      });
    } catch (err) {
      // Гонка двух POST одним источником: partial unique уже отклонил дубль
      // (23505). Отдаём 409 с текущей активной задачей, а не 500.
      if (!isUniqueViolationError(err)) throw err;
      const active = await findActiveIngestJob(db, body.source.type, body.source.ref);
      throw conflict(
        "job_exists",
        "Active ingest job for this source already exists",
        active ? { job: toIngestJobDto(active) } : undefined,
      );
    }
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

  /** Статус ingest-задачи: любому аутентифицированному, но error — только
   * owner/admin (см. toIngestJobDto). */
  app.get("/ingest/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const row = await getIngestJob(db, id);
    if (!row) throw notFound(`Ingest job ${id} not found`);
    const isStaff = request.user.role === "admin" || request.user.role === "owner";
    return { job: toIngestJobDto(row, { includeError: isStaff }) };
  });
}
