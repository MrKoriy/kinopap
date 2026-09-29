import {
  loginSchema,
  refreshSchema,
  registerSchema,
  type User,
} from "@zal/api-client";
import type { Db } from "@zal/db";
import {
  createInvite,
  createRefreshToken,
  findRefreshToken,
  findUserByEmail,
  findUserById,
  getDefaultProfile,
  hashPassword,
  listInvites,
  registerUserWithInvite,
  revokeAllUserTokens,
  revokeRefreshToken,
  type UserRow,
  verifyPassword,
} from "@zal/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import { badRequest, conflict, parseOrThrow, unauthorized } from "../lib/http";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashToken,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../lib/tokens";
import { requireRole } from "../plugins/auth";

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

/** Муляж-хэш для логина с несуществующим email: scrypt-прогон всегда
 * происходит (формат тот же, что у hashPassword), чтобы ответ на
 * неизвестный адрес не прилетал быстрее — timing-оракул перечисления. */
const DUMMY_PASSWORD_HASH =
  "scrypt$a096ef5f42e73b504e24b426e085d793$5c27841c5491dd9d0d7f48acbfe212ce8db018d6580dcf9458cd57695dc130c5";

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

/** Токен ротации: httpOnly-cookie (веб) или тело (мобила, Keychain).
 * Раньше refresh/logout парсили тело raw-`.parse` — мусорное тело
 * поднимало ZodError до 500 вместо 400. */
function extractRefreshToken(request: FastifyRequest): string | undefined {
  const cookie = request.cookies[REFRESH_COOKIE];
  if (cookie) return cookie;
  if (request.body == null) return undefined;
  return parseOrThrow(refreshSchema, request.body).refreshToken;
}

async function issueTokens(
  app: FastifyInstance,
  db: Db,
  user: UserRow,
  reply?: FastifyReply,
  config?: Config,
  /** Метаданные сессии: видны при аудите/детекции кражи токена. */
  meta?: { userAgent?: string | null; ip?: string | null },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  // pid в payload: authed-роуты берут profileId из токена, а не из БД.
  const profile = await getDefaultProfile(db, user.id);
  const accessToken = app.jwt.sign(
    { sub: user.id, role: user.role, pid: profile.id, typ: "access" },
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );
  const refresh = generateRefreshToken();
  await createRefreshToken(db, {
    userId: user.id,
    tokenHash: refresh.hash,
    expiresAt: refresh.expiresAt,
    userAgent: meta?.userAgent ?? null,
    ip: meta?.ip ?? null,
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
    const meta = {
      userAgent: request.headers["user-agent"] ?? null,
      ip: request.ip,
    };

    // Пользователь + списание инвайта + профиль — одной транзакцией:
    // без отката на «полпути» и без 500 на гонку одинаковых email.
    const reg = await registerUserWithInvite(db, {
      email: body.email,
      passwordHash: await hashPassword(body.password),
      name: body.name,
      inviteCode: body.invite,
    });
    if (!reg.ok) {
      if (reg.reason === "email_taken") {
        throw conflict("email_taken", "Email already registered");
      }
      throw badRequest("invalid_invite", "Invite code is invalid or exhausted");
    }

    const tokens = await issueTokens(app, db, reg.user, reply, deps.config, meta);
    reply.code(201);
    return { user: toUserDto(reg.user), tokens };
    },
  );

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const body = parseOrThrow(loginSchema, request.body);
    const user = await findUserByEmail(db, body.email);
    // Единый ответ на неверный email/пароль — не даём перебирать. Хэш
    // считаем всегда (нет юзера — против DUMMY), чтобы и время совпадало.
    const passwordOk = await verifyPassword(
      body.password,
      user?.isActive ? user.passwordHash : DUMMY_PASSWORD_HASH,
    );
    if (!user?.isActive || !passwordOk) {
      throw unauthorized("Invalid email or password");
    }
    const tokens = await issueTokens(app, db, user, reply, deps.config, {
      userAgent: request.headers["user-agent"] ?? null,
      ip: request.ip,
    });
    return { user: toUserDto(user), tokens };
  });

  /** Ротация refresh: старый отзывается, выдаётся новый. Токен приходит
   * телом (мобила, Keychain) или httpOnly-cookie (веб). */
  app.post(
    "/auth/refresh",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const raw = extractRefreshToken(request);
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
    const tokens = await issueTokens(app, db, user, reply, deps.config, {
      userAgent: request.headers["user-agent"] ?? null,
      ip: request.ip,
    });
    return { tokens };
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    const raw = extractRefreshToken(request);
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
      preHandler: [app.authenticate, requireRole("owner", "admin")],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
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

  app.get(
    "/invites",
    { preHandler: [app.authenticate, requireRole("owner", "admin")] },
    async () => {
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
