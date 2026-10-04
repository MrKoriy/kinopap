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
  /** Сколько часов кэш резолва (media_sources) считается рабочим. */
  RESOLVE_SOURCE_TTL_HOURS: z.coerce.number().positive().default(48),
  /** Фоновый прогрев популярного (PREWARM=1 в проде, в тестах выключен). */
  PREWARM: z.stringbool().default(false),
  /** Фоновый догон сезонов: гидрация сериалов без серий + раскладка длинных. */
  GAP_FILL: z.stringbool().default(false),
  GAP_FILL_BATCH: z.coerce.number().int().positive().default(60),
  PREWARM_INTERVAL_MIN: z.coerce.number().positive().default(30),
  PREWARM_BATCH: z.coerce.number().int().positive().default(120),
  PREWARM_TOP: z.coerce.number().int().nonnegative().default(150),
  PREWARM_PAUSE_MS: z.coerce.number().int().nonnegative().default(1500),
  /** Сколько часов проверенная раздача из stream_sources годится клику без rutor. */
  STREAM_SOURCE_TTL_HOURS: z.coerce.number().positive().default(168),
  /** Потолок одновременных фоновых резолвов от префетча карточек. */
  PREFETCH_CONCURRENCY: z.coerce.number().int().nonnegative().default(3),
  /** Telegram-бот уведомлений (токен — у воркера и API, имя — для ссылки t.me/<bot>). */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_NAME: z.string().optional(),
  /** Публичный VAPID-ключ web push (приватный — только у воркера). */
  WEBPUSH_PUBLIC_KEY: z.string().optional(),
  /** Sentry: ошибки API и веба (через /v1/errors). Пусто — только своя лента. */
  SENTRY_DSN: z.string().optional(),
  /** Имя релиза (deploy.sh) — в ошибках и Sentry. */
  RELEASE: z.string().optional(),
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
  resolveSourceTtlMs: number;
  prewarm: boolean;
  gapFill: boolean;
  gapFillBatch: number;
  prewarmIntervalMs: number;
  prewarmBatch: number;
  prewarmTop: number;
  prewarmPauseMs: number;
  /** Первый инстанс PM2 cluster (или единственный процесс). Только он
   * крутит фоновые циклы — прогрев, догон дыр, гигиену: N копий одного
   * цикла били бы rutor и БД N раз. */
  primaryInstance: boolean;
  streamSourceTtlMs: number;
  prefetchConcurrency: number;
  telegramBotName?: string;
  telegramBotToken?: string;
  webpushPublicKey?: string;
  sentryDsn?: string;
  release?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  // PM2 нумерует инстансы в NODE_APP_INSTANCE (и в cluster, и в fork);
  // вне PM2 переменной нет — процесс единственный, он и первичный.
  const primaryInstance = (env.NODE_APP_INSTANCE ?? "0") === "0";
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
    resolveSourceTtlMs: e.RESOLVE_SOURCE_TTL_HOURS * 60 * 60 * 1000,
    prewarm: e.PREWARM && primaryInstance,
    gapFill: e.GAP_FILL && primaryInstance,
    gapFillBatch: e.GAP_FILL_BATCH,
    prewarmIntervalMs: e.PREWARM_INTERVAL_MIN * 60 * 1000,
    prewarmBatch: e.PREWARM_BATCH,
    prewarmTop: e.PREWARM_TOP,
    prewarmPauseMs: e.PREWARM_PAUSE_MS,
    primaryInstance,
    streamSourceTtlMs: e.STREAM_SOURCE_TTL_HOURS * 60 * 60 * 1000,
    prefetchConcurrency: e.PREFETCH_CONCURRENCY,
    telegramBotName: e.TELEGRAM_BOT_NAME?.replace(/^@/, "") || undefined,
    telegramBotToken: e.TELEGRAM_BOT_TOKEN || undefined,
    webpushPublicKey: e.WEBPUSH_PUBLIC_KEY || undefined,
    sentryDsn: e.SENTRY_DSN || undefined,
    release: e.RELEASE || undefined,
  };
}
