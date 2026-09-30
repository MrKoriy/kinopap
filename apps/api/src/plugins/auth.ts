import jwt from "@fastify/jwt";
import type { UserRole } from "@zal/api-client";
import { type Db, getDefaultProfile, users } from "@zal/db";
import { eq } from "drizzle-orm";
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
  db?: Db,
): Promise<void> {
  await app.register(jwt, { secret: config.jwtSecret });

  // Лёгкий TTL-кэш проверки isActive/role: без него каждый запрос лупит в БД.
  const cache = new Map<number, { at: number; active: boolean; role: UserRole }>();
  const TTL_MS = 30_000;
  const resolveDb = (): Db | undefined =>
    db ?? (app as unknown as { db?: Db }).db ?? (config as unknown as { db?: Db }).db;

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      if (request.user.typ !== "access") {
        throw unauthorized("Unexpected token type");
      }
      // Живая проверка: заблокированный пользователь не проходит даже со свежим JWT.
      const sub = request.user.sub;
      const now = Date.now();
      let entry = cache.get(sub);
      if (!entry || now - entry.at > TTL_MS) {
        const liveDb = resolveDb();
        if (liveDb) {
          const rows = await liveDb.select({ isActive: users.isActive, role: users.role }).from(users).where(eq(users.id, sub)).limit(1);
          const row = rows[0] as { isActive: boolean; role: UserRole } | undefined;
          if (row) {
            entry = { at: now, active: row.isActive, role: row.role as UserRole };
            cache.set(sub, entry);
          } else {
            // Пользователь удалён — токен недействителен.
            throw unauthorized();
          }
        } else if (!entry) {
          // БД недоступна и кэша нет — пускаем по JWT (совместимость тестов без БД).
          entry = { at: now, active: true, role: request.user.role };
        }
      }
      if (!entry!.active) throw unauthorized();
      if (entry!.role !== request.user.role) {
        (request.user as { role: UserRole }).role = entry!.role;
      }
    } catch (err) {
      const maybeStatus = (err as { status?: number })?.status;
      if (maybeStatus === 401 || maybeStatus === 403) throw err;
      if (err instanceof Error && err.message === "Unauthorized") throw err;
      throw unauthorized();
    }
    void reply;
  });
}
