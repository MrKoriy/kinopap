// Прод-конфиг PM2. Секреты НЕ хранятся здесь: pm2 стартует с env, в котором
// должен быть JWT_SECRET (например `env $(cat /opt/kinopap/.env) pm2 start`).
// Публичные адреса при желании тоже перекрываются env'ом.
//
// cwd приложений — /opt/kinopap/current, симлинк на живой релиз, а не на
// /opt/kinopap. Код деплоится в releases/<ts>, и каталог приложений обязан
// следовать за переключением симлинка. Обратная сторона: pm2 хранит pm_cwd,
// разобранный при старте, поэтому перезапускать приложения нужно через
// `delete` + `start` (это делает bin/restart-apps.sh) — `pm2 reload` оставил бы
// их работать из прежнего релиза, отрапортовав успех.
//
// DATABASE_URL обязателен и без значения по умолчанию: раньше здесь лежал
// `postgres://zal:zal@localhost:5433/zal`, то есть пароль базы в публичном
// репозитории. Запасное значение к тому же маскировало бы отсутствие env —
// API поднялся бы и молча ходил не туда.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL не задан. pm2 должен стартовать с env из /opt/kinopap/.env " +
      "(deploy.sh делает это сам).",
  );
}

// Каталог релиза. Торрсервер стоит вне него: бинарь и данные раздач живут в
// /opt/kinopap/{bin,data} и переживают любой деплой.
const RELEASE_DIR = "/opt/kinopap/current";

// Прод запускает собранный JS (`pnpm build` → apps/*/dist, Next standalone),
// а не `tsx` на лету: холодный старт быстрее, памяти меньше, и API можно
// поднять в PM2 cluster. Если сборки в релизе нет (откат на релиз до этой
// схемы), приложение стартует по-старому через tsx / next start.
const fs = require("node:fs");
const path = require("node:path");
const built = (rel) => fs.existsSync(path.join(RELEASE_DIR, rel));
// Имя релиза (каталог, на который смотрит current) — в ошибках и Sentry.
const RELEASE_NAME = (() => {
  try {
    return path.basename(fs.realpathSync(RELEASE_DIR));
  } catch {
    return undefined;
  }
})();
const API_ENTRY = "apps/api/dist/server.js";
const WORKER_ENTRY = "apps/worker/dist/index.js";
const WEB_ENTRY = "apps/web/.next/standalone/apps/web/server.js";
const apiBuilt = built(API_ENTRY);
const workerBuilt = built(WORKER_ENTRY);
const webBuilt = built(WEB_ENTRY);

// Инстансы API. Кэш выдачи rutor и счётчики rate limit — в Redis, фоновые
// циклы (прогрев, догон дыр, гигиена) крутит только инстанс 0
// (NODE_APP_INSTANCE), поэтому копии не дерутся. API_INSTANCES=1 — один процесс.
const API_INSTANCES = Math.max(1, Number(process.env.API_INSTANCES ?? "2") || 1);
const apiCluster = apiBuilt && API_INSTANCES > 1;

module.exports = {
  apps: [
    {
      name: "kinopap-torrserver",
      script: "/opt/kinopap/bin/torrserver",
      args: "--port 7002 --path /opt/kinopap/data/torrserver",
      autorestart: true,
      max_restarts: 10,
    },
    {
      name: "kinopap-api",
      cwd: RELEASE_DIR,
      ...(apiBuilt
        ? { script: API_ENTRY, interpreter: "node", node_args: "--enable-source-maps" }
        : { script: "pnpm", args: "--filter @zal/api exec tsx src/server.ts" }),
      ...(apiCluster ? { exec_mode: "cluster", instances: API_INSTANCES } : {}),
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT ?? "7001",
        DATABASE_URL,
        // Без REDIS_URL API стартует без очереди fill — /v1/discover
        // выполняется синхронно и nginx рвёт его по таймауту (504).
        // Адрес — системный redis на хосте, см. docker-compose.yml.
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
        TORRSERVER_URL: process.env.TORRSERVER_URL ?? "http://127.0.0.1:7002",
        TORRSERVER_PUBLIC_URL: process.env.TORRSERVER_PUBLIC_URL,
        JWT_SECRET: process.env.JWT_SECRET,
        TMDB_API_KEY: process.env.TMDB_API_KEY,
        CORS_ORIGIN: process.env.CORS_ORIGIN,
        MEDIA_BASE_URL: process.env.MEDIA_BASE_URL,
        COOKIE_SECURE: process.env.COOKIE_SECURE,
        ANILIBRIA_URL: process.env.ANILIBRIA_URL,
        // Подпись ссылок /gst для nginx secure_link (см. bin/deploy.sh).
        GST_LINK_SECRET: process.env.GST_LINK_SECRET,
        // API в проде за nginx — XFF доверяем явно (дефолт кода теперь
        // false: без прокси заголовок подделывается и обходит лимиты).
        // Перекрывается через .env, если топология изменится.
        TRUST_PROXY: process.env.TRUST_PROXY ?? "true",
        // Старый in-process прогрев API. Его работу теперь делает воркер
        // (stream-precheck + stream-headwarm) — по умолчанию выключен, чтобы
        // rutor не получал двойную нагрузку; вернуть можно PREWARM=1 в .env.
        PREWARM: process.env.PREWARM ?? "0",
        // Сколько часов проверенная раздача из stream_sources годится клику без rutor.
        STREAM_SOURCE_TTL_HOURS: process.env.STREAM_SOURCE_TTL_HOURS ?? "168",
        // Догон серий сериалов и раскладка длинных сезонов — раз в час.
        GAP_FILL: process.env.GAP_FILL ?? "1",
        RESOLVE_SOURCE_TTL_HOURS: process.env.RESOLVE_SOURCE_TTL_HOURS ?? "48",
        // Уведомления: бот (ссылка привязки) и публичный VAPID-ключ web push.
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_BOT_NAME: process.env.TELEGRAM_BOT_NAME,
        WEBPUSH_PUBLIC_KEY: process.env.WEBPUSH_PUBLIC_KEY,
        // Наблюдаемость: Sentry (необязательно) и имя релиза в ошибках.
        SENTRY_DSN: process.env.SENTRY_DSN,
        RELEASE: RELEASE_NAME,
      },
    },
    {
      name: "kinopap-worker",
      cwd: RELEASE_DIR,
      ...(workerBuilt
        ? { script: WORKER_ENTRY, interpreter: "node", node_args: "--enable-source-maps" }
        : { script: "pnpm", args: "--filter @zal/worker exec tsx src/index.ts" }),
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
        MEDIA_ROOT: process.env.MEDIA_ROOT,
        MEDIA_BASE_URL: process.env.MEDIA_BASE_URL,
        LOCAL_SOURCE_ROOT: process.env.LOCAL_SOURCE_ROOT,
        TMDB_API_KEY: process.env.TMDB_API_KEY,
        // Точечный сброс ISR веба (lib/revalidate.ts): без секрета выключен.
        REVALIDATE_SECRET: process.env.REVALIDATE_SECRET,
        WEB_INTERNAL_URL: process.env.WEB_INTERNAL_URL ?? "http://127.0.0.1:7000",
        // Автопилот каталога: свежие релизы/аниме каждые 6 ч, широкий проход и трейлеры — раз в сутки.
        AUTOPILOT: process.env.AUTOPILOT ?? "1",
        // Старт видео: раздачи заранее (stream-precheck) и головы файлов топ-N
        // в кэше TorrServer (stream-headwarm). Потолок диска — общий с
        // kinopap-ts-prune.timer (TS_CACHE_MAX_GB из того же .env).
        STREAM_PRECHECK: process.env.STREAM_PRECHECK ?? "1",
        TORRSERVER_URL: process.env.TORRSERVER_URL ?? "http://127.0.0.1:7002",
        ANILIBRIA_URL: process.env.ANILIBRIA_URL,
        TS_CACHE_DIR: process.env.TS_CACHE_DIR ?? "/opt/kinopap/data/ts-cache",
        TS_CACHE_MAX_GB: process.env.TS_CACHE_MAX_GB ?? "25",
        STREAM_HEAD_WARM_TOP: process.env.STREAM_HEAD_WARM_TOP ?? "200",
        STREAM_HEAD_MB: process.env.STREAM_HEAD_MB ?? "64",
        STREAM_PRECHECK_BATCH: process.env.STREAM_PRECHECK_BATCH,
        STREAM_PRECHECK_TOP: process.env.STREAM_PRECHECK_TOP,
        STREAM_PRECHECK_RUTOR_PER_MIN: process.env.STREAM_PRECHECK_RUTOR_PER_MIN,
        // Уведомления о новых сериях и алерты Ops (src/notify.ts). NOTIFY=0 — выкл.
        NOTIFY: process.env.NOTIFY ?? "1",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        WEBPUSH_PUBLIC_KEY: process.env.WEBPUSH_PUBLIC_KEY,
        WEBPUSH_PRIVATE_KEY: process.env.WEBPUSH_PRIVATE_KEY,
        WEBPUSH_SUBJECT: process.env.WEBPUSH_SUBJECT,
        NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
        CATALOG_DAEMON: process.env.CATALOG_DAEMON,
        DAEMON_SKIP: process.env.DAEMON_SKIP,
        SENTRY_DSN: process.env.SENTRY_DSN,
        RELEASE: RELEASE_NAME,
      },
    },
    {
      name: "kinopap-web",
      cwd: RELEASE_DIR,
      // Standalone-сервер Next: только трассированные зависимости, без pnpm и
      // next CLI в цепочке процессов. Статику рядом кладёт postbuild-скрипт.
      ...(webBuilt
        ? { script: WEB_ENTRY, interpreter: "node" }
        : { script: "pnpm", args: "--filter @zal/web start -p 7000" }),
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: "7000",
        // standalone server.js слушает HOSTNAME:PORT (next start — 0.0.0.0).
        HOSTNAME: "0.0.0.0",
        // Секрет POST /api/revalidate: воркер сбрасывает ISR-теги тайтлов.
        REVALIDATE_SECRET: process.env.REVALIDATE_SECRET,
        NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
        INTERNAL_API_URL:
          process.env.INTERNAL_API_URL ?? "http://127.0.0.1:7001",
      },
    },
  ],
};
