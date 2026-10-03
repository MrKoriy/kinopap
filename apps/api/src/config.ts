import { z } from "zod";

const envSchema = z.object({
  // Дефолт — только для локальной разработки, и пароль в нём намеренно НЕ тот,
  // что в проде: раньше здесь стоял боевой `zal:zal`, то есть пароль рабочей
  // базы лежал в публичном репозитории. Прод всегда задаёт DATABASE_URL явно.
  DATABASE_URL: z.string().default("postgres://zal:dev@localhost:5432/zal"),
  // Без дефолта: забыли env в проде — процесс откажется стартовать, а не
  // подпишет все токены публично известной строкой.
  JWT_SECRET: z.string().min(32),
  // Раньше здесь был адрес MinIO (`localhost:9000/zal-media`), которым никто не
  // пользуется: медиа отдаёт nginx из MEDIA_ROOT по относительному пути.
  MEDIA_BASE_URL: z.string().default("/media"),
  TORRSERVER_URL: z.string().default("http://localhost:8090"),
  TORRSERVER_PUBLIC_URL: z.string().optional(),
  TMDB_API_KEY: z.string().optional(),
  /** Базовый URL AniLibria (фаза аниме в fill + резолв серий). */
  ANILIBRIA_URL: z.string().default("https://anilibria.top/api/v1"),
  PORT: z.coerce.number().int().default(3001),
  /** Разрешённые CORS-источники, через запятую; "*" — публичный (без кредов). */
  CORS_ORIGIN: z.string().default("*"),
  /** Secure-флаг cookie: включать только за TLS-прокси (COOKIE_SECURE=1).
   * stringbool: coerce.boolean читал "false"/"0" как true. */
  COOKIE_SECURE: z.stringbool().default(false),
  /** Доверять X-Forwarded-For. Безопасный дефолт — false: при прямом
    * доступе к порту подделка заголовка обходит per-IP rate limit.
    * За nginx (прод) включать явно: TRUST_PROXY=1. */
  TRUST_PROXY: z.stringbool().default(false),
  /** Секрет подписи ссылок /gst (nginx secure_link). Пусто — ссылки без подписи. */
  GST_LINK_SECRET: z
    .string()
    .optional()
    .refine((v) => !v || v.length >= 32, "GST_LINK_SECRET: минимум 32 символа"),
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
  trustProxy: boolean;
  gstLinkSecret?: string;
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
    trustProxy: e.TRUST_PROXY,
    gstLinkSecret: e.GST_LINK_SECRET || undefined,
  };
}
