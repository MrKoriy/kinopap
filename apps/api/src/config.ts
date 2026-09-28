import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgres://zal:zal@localhost:5432/zal"),
  // Без дефолта: забыли env в проде — процесс откажется стартовать, а не
  // подпишет все токены публично известной строкой.
  JWT_SECRET: z.string().min(32),
  MEDIA_BASE_URL: z.string().default("http://localhost:9000/zal-media"),
  TORRSERVER_URL: z.string().default("http://localhost:8090"),
  TORRSERVER_PUBLIC_URL: z.string().optional(),
  TMDB_API_KEY: z.string().optional(),
  /** Базовый URL AniLibria (фаза аниме в fill + резолв серий). */
  ANILIBRIA_URL: z.string().default("https://anilibria.top/api/v1"),
  PORT: z.coerce.number().int().default(3001),
  /** Разрешённые CORS-источники, через запятую; "*" — публичный (без кредов). */
  CORS_ORIGIN: z.string().default("*"),
  /** Secure-флаг cookie: включать только за TLS-прокси (COOKIE_SECURE=1). */
  COOKIE_SECURE: z.coerce.boolean().default(false),
});

export interface Config {
  databaseUrl: string;
  jwtSecret: string;
  mediaBaseUrl: string;
  torrServerUrl: string;
  torrServerPublicUrl?: string;
  tmdbApiKey?: string;
  anilibriaUrl: string;
  port: number;
  corsOrigin: string;
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    mediaBaseUrl: e.MEDIA_BASE_URL,
    torrServerUrl: e.TORRSERVER_URL,
    torrServerPublicUrl: e.TORRSERVER_PUBLIC_URL,
    tmdbApiKey: e.TMDB_API_KEY,
    anilibriaUrl: e.ANILIBRIA_URL,
    port: e.PORT,
    corsOrigin: e.CORS_ORIGIN,
    cookieSecure: e.COOKIE_SECURE,
  };
}
