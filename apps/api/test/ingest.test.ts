import { describe, expect, it } from "vitest";
import { ingestResponseSchema } from "@zal/api-client";
import { users } from "@zal/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./setup";
import { makeOwnerWithInvite } from "./fixtures";
import type { IngestJobPayload, IngestQueue } from "../src/ingest-queue";

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
