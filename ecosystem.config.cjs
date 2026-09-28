// Прод-конфиг PM2. Секреты НЕ хранятся здесь: pm2 стартует с env, в котором
// должен быть JWT_SECRET (например `env $(cat /opt/kinopap/.env) pm2 start`).
// Публичные адреса при желании тоже перекрываются env'ом.
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
      cwd: "/opt/kinopap",
      script: "pnpm",
      args: "--filter @zal/api exec tsx src/server.ts",
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT ?? "7001",
        DATABASE_URL:
          process.env.DATABASE_URL ?? "postgres://zal:zal@localhost:5433/zal",
        // Без REDIS_URL API стартует без очереди fill — /v1/discover
        // выполняется синхронно и nginx рвёт его по таймауту (504).
        REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
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
      cwd: "/opt/kinopap",
      script: "pnpm",
      args: "--filter @zal/worker exec tsx src/index.ts",
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        DATABASE_URL:
          process.env.DATABASE_URL ?? "postgres://zal:zal@localhost:5433/zal",
        REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
        MEDIA_ROOT: process.env.MEDIA_ROOT,
        MEDIA_BASE_URL: process.env.MEDIA_BASE_URL,
        LOCAL_SOURCE_ROOT: process.env.LOCAL_SOURCE_ROOT,
        TMDB_API_KEY: process.env.TMDB_API_KEY,
      },
    },
    {
      name: "kinopap-web",
      cwd: "/opt/kinopap",
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
