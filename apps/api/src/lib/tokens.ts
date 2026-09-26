import { createHash, randomBytes } from "node:crypto";

/** Access живёт 15 минут, refresh — 30 дней с ротацией. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 30;

export interface RefreshTokenIssue {
  raw: string;
  hash: string;
  expiresAt: Date;
}

/** Клиенту отдаём raw, в БД кладём только hash. */
export function generateRefreshToken(): RefreshTokenIssue {
  const raw = randomBytes(32).toString("base64url");
  return {
    raw,
    hash: hashToken(raw),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
  };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
