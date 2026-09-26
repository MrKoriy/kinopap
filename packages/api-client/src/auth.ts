import { z } from "zod";
import { userRoleSchema, type UserRole } from "./common";

export const registerSchema = z.object({
  invite: z.string().trim().min(6).max(32),
  email: z.email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(120),
});
export const loginSchema = z.object({
  email: z.email().max(255),
  password: z.string().min(1).max(128),
});
export const refreshSchema = z.object({
  refreshToken: z.string().min(10).max(200),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;

export const userSchema = z.object({
  id: z.number().int(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Сколько секунд живёт access-токен. */
  expiresIn: z.number().int(),
});
export type Tokens = z.infer<typeof tokensSchema>;

export const authResponseSchema = z.object({
  user: userSchema,
  tokens: tokensSchema,
});
export const meResponseSchema = z.object({ user: userSchema });
export const refreshResponseSchema = z.object({ tokens: tokensSchema });
export const logoutResponseSchema = z.object({ ok: z.boolean() });

export type AuthResponse = z.infer<typeof authResponseSchema>;

export type { UserRole };
