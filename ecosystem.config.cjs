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
      script: "pnpm",
      args: "--filter @zal/api exec tsx src/server.ts",
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
      },
    },
    {
      name: "kinopap-worker",
      cwd: RELEASE_DIR,
      script: "pnpm",
      args: "--filter @zal/worker exec tsx src/index.ts",
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
      },
    },
    {
      name: "kinopap-web",
      cwd: RELEASE_DIR,
      script: "pnpm",
      args: "--filter @zal/web start -p 7000",
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: "7000",
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
        INTERNAL_API_URL:
          process.env.INTERNAL_API_URL ?? "http://127.0.0.1:7001",
      },
    },
  ],
};
