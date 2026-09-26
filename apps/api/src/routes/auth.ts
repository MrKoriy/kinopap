import type { FastifyInstance } from "fastify";
import {
  loginSchema,
  refreshSchema,
  registerSchema,
  type User,
} from "@zal/api-client";
import {
  consumeInvite,
  createProfile,
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  hashPassword,
  verifyPassword,
  createRefreshToken,
  findRefreshToken,
  revokeAllUserTokens,
  revokeRefreshToken,
  type UserRow,
} from "@zal/db";
import type { Config } from "../config";
import type { Db } from "@zal/db";
import { badRequest, conflict, parseOrThrow, unauthorized } from "../lib/http";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashToken,
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

async function issueTokens(
  app: FastifyInstance,
  db: Db,
  user: UserRow,
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
  app.post("/auth/register", async (request, reply) => {
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
    const tokens = await issueTokens(app, db, user);
    reply.code(201);
    return { user: toUserDto(user), tokens };
  });

  app.post("/auth/login", async (request) => {
    const body = parseOrThrow(loginSchema, request.body);
    const user = await findUserByEmail(db, body.email);
    // Единый ответ на неверный email/пароль — не даём перебирать.
    if (!user || !user.isActive || !(await verifyPassword(body.password, user.passwordHash))) {
      throw unauthorized("Invalid email or password");
    }
    const tokens = await issueTokens(app, db, user);
    return { user: toUserDto(user), tokens };
  });

  /** Ротация refresh: старый отзывается, выдаётся новый. */
  app.post("/auth/refresh", async (request) => {
    const body = parseOrThrow(refreshSchema, request.body);
    const row = await findRefreshToken(db, hashToken(body.refreshToken));
    if (!row) throw unauthorized("Unknown refresh token");

    if (row.revokedAt) {
      // Повторное использование старого токена — возможная кража, гасим всё.
      await revokeAllUserTokens(db, row.userId);
      throw unauthorized("Refresh token reuse detected");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw unauthorized("Refresh token expired");
    }

    const user = await findUserById(db, row.userId);
    if (!user || !user.isActive) throw unauthorized();

    await revokeRefreshToken(db, row.id);
    const tokens = await issueTokens(app, db, user);
    return { tokens };
  });

  app.post("/auth/logout", async (request) => {
    const body = parseOrThrow(refreshSchema, request.body);
    const row = await findRefreshToken(db, hashToken(body.refreshToken));
    if (row && !row.revokedAt) {
      await revokeRefreshToken(db, row.id);
    }
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (request) => {
    const user = await findUserById(db, request.user.sub);
    if (!user) throw unauthorized();
    return { user: toUserDto(user) };
  });
}
