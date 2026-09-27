import {
  loginSchema,
  refreshSchema,
  registerSchema,
  type User,
} from "@zal/api-client";
import type { Db } from "@zal/db";
import {
  consumeInvite,
  createInvite,
  createProfile,
  createRefreshToken,
  createUser,
  deleteUser,
  findRefreshToken,
  findUserByEmail,
  findUserById,
  hashPassword,
  listInvites,
  revokeAllUserTokens,
  revokeRefreshToken,
  type UserRow,
  verifyPassword,
} from "@zal/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import { badRequest, conflict, forbidden, parseOrThrow, unauthorized } from "../lib/http";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashToken,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../lib/tokens";

export function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

/** httpOnly-cookie с refresh-токеном для веба; мобила шлёт токен телом. */
const REFRESH_COOKIE = "zal_rt";

function setRefreshCookie(reply: FastifyReply, config: Config, raw: string): void {
  reply.setCookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    // Только путь auth: refresh/logout, иначе кука светится в каждом запросе.
    path: "/v1/auth",
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
    secure: config.cookieSecure,
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: "/v1/auth" });
}

async function issueTokens(
  app: FastifyInstance,
  db: Db,
  user: UserRow,
  reply?: FastifyReply,
  config?: Config,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const accessToken = app.jwt.sign(
    { sub: user.id, role: user.role, typ: "access" },
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );
  const refresh = generateRefreshToken();
  await createRefreshToken(db, {
    userId: user.id,
    tokenHash: refresh.hash,
    expiresAt: refresh.expiresAt,
  });
  if (reply && config) setRefreshCookie(reply, config, refresh.raw);
  return {
    accessToken,
    refreshToken: refresh.raw,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function authRoutes(
  app: FastifyInstance,
  deps: { db: Db; config: Config },
): Promise<void> {
  const { db } = deps;

  /** Регистрация по инвайт-коду (закрытый клуб). */
  app.post(
    "/auth/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const body = parseOrThrow(registerSchema, request.body);

    const existing = await findUserByEmail(db, body.email);
    if (existing) throw conflict("email_taken", "Email already registered");

    const user = await createUser(db, {
      email: body.email,
      passwordHash: await hashPassword(body.password),
      name: body.name,
    });

    // Инвайт списываем атомарно; если не вышло — откатываем пользователя.
    const consumed = await consumeInvite(db, body.invite, user.id);
    if (!consumed) {
      await deleteUser(db, user.id);
      throw badRequest("invalid_invite", "Invite code is invalid or exhausted");
    }

    await createProfile(db, { userId: user.id, name: body.name });
    const tokens = await issueTokens(app, db, user, reply, deps.config);
    reply.code(201);
    return { user: toUserDto(user), tokens };
    },
  );

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const body = parseOrThrow(loginSchema, request.body);
    const user = await findUserByEmail(db, body.email);
    // Единый ответ на неверный email/пароль — не даём перебирать.
    if (!user?.isActive || !(await verifyPassword(body.password, user.passwordHash))) {
      throw unauthorized("Invalid email or password");
    }
    const tokens = await issueTokens(app, db, user, reply, deps.config);
    return { user: toUserDto(user), tokens };
  });

  /** Ротация refresh: старый отзывается, выдаётся новый. Токен приходит
   * телом (мобила, Keychain) или httpOnly-cookie (веб). */
  app.post(
    "/auth/refresh",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const raw =
      request.cookies[REFRESH_COOKIE] ??
      (request.body ? refreshSchema.parse(request.body).refreshToken : undefined);
    if (!raw) throw unauthorized("No refresh token");
    const row = await findRefreshToken(db, hashToken(raw));
    if (!row) {
      // Неизвестный токен в cookie мог остаться после отзыва — чистим.
      clearRefreshCookie(reply);
      throw unauthorized("Unknown refresh token");
    }

    if (row.revokedAt) {
      // Повторное использование старого токена — возможная кража, гасим всё.
      clearRefreshCookie(reply);
      await revokeAllUserTokens(db, row.userId);
      throw unauthorized("Refresh token reuse detected");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      clearRefreshCookie(reply);
      throw unauthorized("Refresh token expired");
    }

    const user = await findUserById(db, row.userId);
    if (!user?.isActive) throw unauthorized();

    // Атомарный guard: параллельный запрос уже отозвал токен → reuse.
    const revoked = await revokeRefreshToken(db, row.id);
    if (!revoked) {
      clearRefreshCookie(reply);
      await revokeAllUserTokens(db, row.userId);
      throw unauthorized("Refresh token reuse detected");
    }
    const tokens = await issueTokens(app, db, user, reply, deps.config);
    return { tokens };
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    const raw =
      request.cookies[REFRESH_COOKIE] ??
      (request.body ? refreshSchema.parse(request.body).refreshToken : undefined);
    clearRefreshCookie(reply);
    if (raw) {
      const row = await findRefreshToken(db, hashToken(raw));
      if (row && !row.revokedAt) {
        await revokeRefreshToken(db, row.id);
      }
    }
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (request) => {
    const user = await findUserById(db, request.user.sub);
    if (!user) throw unauthorized();
    return { user: toUserDto(user) };
  });

  /* ---------- Инвайты (owner/admin) ---------- */

  /** Создать инвайт: раньше коды существовали только через CLI/seed. */
  app.post(
    "/invites",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (request.user.role !== "owner" && request.user.role !== "admin") {
        throw forbidden("Invites are available to owner/admin only");
      }
      const body = parseOrThrow(
        z.object({
          maxUses: z.coerce.number().int().min(1).max(100).default(1),
          expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
        }),
        request.body ?? {},
      );
      const invite = await createInvite(db, {
        createdBy: request.user.sub,
        maxUses: body.maxUses,
        expiresAt: body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
          : null,
      });
      reply.code(201);
      return {
        invite: {
          code: invite.code,
          maxUses: invite.maxUses,
          uses: invite.uses,
          expiresAt: invite.expiresAt?.toISOString() ?? null,
        },
      };
    },
  );

  app.get("/invites", { preHandler: app.authenticate }, async (request) => {
    if (request.user.role !== "owner" && request.user.role !== "admin") {
      throw forbidden("Invites are available to owner/admin only");
    }
    const rows = await listInvites(db);
    return {
      invites: rows.map((i) => ({
        code: i.code,
        maxUses: i.maxUses,
        uses: i.uses,
        expiresAt: i.expiresAt?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(),
      })),
    };
  });
}
