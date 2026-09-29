import jwt from "@fastify/jwt";
import type { UserRole } from "@zal/api-client";
import { type Db, getDefaultProfile } from "@zal/db";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Config } from "../config";
import { forbidden, unauthorized } from "../lib/http";

export interface AccessPayload {
  sub: number;
  role: UserRole;
  typ: "access";
  /** Дефолтный profileId: убирает запрос профиля из каждого authed-роута.
   * Опционален — токены, выданные до pid, дорезолваются из БД. */
  pid?: number;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: AccessPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** Роль-гейт: allow-list, а не «запретить member». Новая роль не должна
 * молча получать административные права — расширяй список явно.
 * Ставится после app.authenticate. */
export function requireRole(...roles: UserRole[]): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    if (!roles.includes(request.user.role)) {
      throw forbidden("This action is available to owner/admin only");
    }
  };
}

/** Опциональная авторизация: гость — это гость, а не 401. Невалидный
 * или отсутствующий токен просто означает анонима. */
export async function optionalUser(
  request: FastifyRequest,
): Promise<AccessPayload | null> {
  try {
    await request.jwtVerify();
    return request.user.typ === "access" ? request.user : null;
  } catch {
    return null;
  }
}

/** profileId дефолтного профиля: из токена, а для старых токенов (без
 * pid в payload) — дорезолв из БД. После ротации (TTL 15 мин) pid
 * приезжает в каждом свежем токене, запрос профиля исчезает вовсе. */
export async function requireProfileId(
  db: Db,
  request: FastifyRequest,
): Promise<number> {
  const pid = request.user.pid;
  if (pid != null) return pid;
  return (await getDefaultProfile(db, request.user.sub)).id;
}

export async function registerAuth(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  await app.register(jwt, { secret: config.jwtSecret });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      if (request.user.typ !== "access") {
        throw unauthorized("Unexpected token type");
      }
    } catch {
      // Не раскрываем причину — просто 401.
      throw unauthorized();
    }
    void reply;
  });
}
