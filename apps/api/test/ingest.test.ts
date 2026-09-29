import { ingestResponseSchema } from "@zal/api-client";
import { ingestJobs, users } from "@zal/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { IngestJobPayload, IngestQueue } from "../src/ingest-queue";
import { makeOwnerWithInvite } from "./fixtures";
import { createTestApp } from "./setup";

function recordingQueue() {
  const enqueued: IngestJobPayload[] = [];
  const queue: IngestQueue = {
    async enqueueIngest(payload) {
      enqueued.push(payload);
    },
  };
  return { queue, enqueued };
}

/**
 * Регистрирует пользователя с указанной ролью и возвращает access-токен.
 * Роль зашита в JWT, поэтому после апгрейда роли логинимся заново.
 */
async function registerWithRole(
  app: Awaited<ReturnType<typeof createTestApp>>,
  email: string,
  role: "owner" | "admin" | "member",
): Promise<string> {
  const { invite } = await makeOwnerWithInvite(app.db);
  const reg = await app.app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { invite, email, password: "hunter2hunter2", name: email },
  });
  expect(reg.statusCode).toBe(201);
  await app.db.update(users).set({ role }).where(eq(users.email, email));

  const login = await app.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: "hunter2hunter2" },
  });
  expect(login.statusCode).toBe(200);
  return (login.json().tokens as { accessToken: string }).accessToken;
}

describe("ingest routes", () => {
  it("owner ставит задачу в очередь и читает статус", async () => {
    const { queue, enqueued } = recordingQueue();
    const app = await createTestApp({ queue });
    const token = await registerWithRole(app, "ingester@zal.local", "owner");

    const res = await app.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source: { type: "local", ref: "movie.mkv" },
        item: { title: "Матрица", year: 1999 },
      },
    });
    expect(res.statusCode).toBe(202);
    const body = ingestResponseSchema.parse(res.json());
    expect(body.job).toMatchObject({ status: "queued", sourceRef: "movie.mkv" });

    // В очередь ушёл валидный payload с id задачи.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      kind: "ingest",
      jobId: body.job.id,
      source: { type: "local", ref: "movie.mkv" },
      item: { title: "Матрица", year: 1999 },
    });

    const status = await app.app.inject({
      method: "GET",
      url: `/v1/ingest/${body.job.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.statusCode).toBe(200);
    expect(ingestResponseSchema.parse(status.json()).job.id).toBe(body.job.id);

    const missing = await app.app.inject({
      method: "GET",
      url: "/v1/ingest/99999",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("дубль активной задачи — 409 с телом существующей задачи", async () => {
    const { queue, enqueued } = recordingQueue();
    const app = await createTestApp({ queue });
    const token = await registerWithRole(app, "dup@zal.local", "owner");

    const payload = {
      source: { type: "local", ref: "dup.mkv" },
      item: { title: "Дубль" },
    };
    const headers = { authorization: `Bearer ${token}` };

    const first = await app.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers,
      payload,
    });
    expect(first.statusCode).toBe(202);
    const firstJob = (first.json() as { job: { id: number } }).job;

    // Тот же источник, пока задача активна: partial unique отклоняет
    // постановку — гонка отдаёт 409 и DTO уже существующей задачи.
    const second = await app.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers,
      payload,
    });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error.code).toBe("job_exists");
    expect(body.error.details.job).toMatchObject({
      id: firstJob.id,
      status: "queued",
      sourceType: "local",
      sourceRef: "dup.mkv",
    });

    // Дубль не ставится в очередь повторно.
    expect(enqueued).toHaveLength(1);

    // После done источник снова свободен: тот же POST проходит.
    await app.db
      .update(ingestJobs)
      .set({ status: "done" })
      .where(eq(ingestJobs.id, firstJob.id));
    const third = await app.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers,
      payload,
    });
    expect(third.statusCode).toBe(202);
  });

  it("member не может запускать ingest", async () => {
    const app = await createTestApp({ queue: recordingQueue().queue });
    const token = await registerWithRole(app, "member@zal.local", "member");

    const res = await app.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source: { type: "local", ref: "movie.mkv" },
        item: { title: "X" },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("сырой error задачи виден только owner/admin, member — generic", async () => {
    const app = await createTestApp({ queue: recordingQueue().queue });
    const adminToken = await registerWithRole(app, "err-admin@zal.local", "admin");
    const memberToken = await registerWithRole(app, "err-member@zal.local", "member");

    const res = await app.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        source: { type: "local", ref: "fail.mkv" },
        item: { title: "Fail" },
      },
    });
    expect(res.statusCode).toBe(202);
    const jobId = (res.json() as { job: { id: number } }).job.id;

    // Воркер упал: в БД лежит сырая строка с путями и ffmpeg-деталями.
    const rawError = "ffmpeg: /data/sources/fail.mkv: no such file";
    await app.db
      .update(ingestJobs)
      .set({ status: "failed", error: rawError })
      .where(eq(ingestJobs.id, jobId));

    const asMember = await app.app.inject({
      method: "GET",
      url: `/v1/ingest/${jobId}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(asMember.statusCode).toBe(200);
    // Контракт DTO цел (error в ответе), но деталей воркера нет.
    const memberBody = ingestResponseSchema.parse(asMember.json());
    expect(memberBody.job.error).toBe("failed");

    const asAdmin = await app.app.inject({
      method: "GET",
      url: `/v1/ingest/${jobId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(ingestResponseSchema.parse(asAdmin.json()).job.error).toBe(rawError);
  });

  it("без токена 401; без очереди — честные 503", async () => {
    const app = await createTestApp();

    const unauth = await app.app.inject({
      method: "POST",
      url: "/v1/ingest",
      payload: {
        source: { type: "local", ref: "movie.mkv" },
        item: { title: "X" },
      },
    });
    expect(unauth.statusCode).toBe(401);

    const token = await registerWithRole(app, "admin@zal.local", "admin");
    const res = await app.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source: { type: "local", ref: "movie.mkv" },
        item: { title: "X" },
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("ingest_unavailable");
  });

  it("отклоняет кривой ingest-запрос", async () => {
    const app = await createTestApp({ queue: recordingQueue().queue });
    const token = await registerWithRole(app, "admin2@zal.local", "admin");

    const res = await app.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source: { type: "torrent", ref: "" },
        item: { title: "" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
