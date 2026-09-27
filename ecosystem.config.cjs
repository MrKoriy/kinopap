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
        PORT: 7001,
        DATABASE_URL: "postgres://zal:zal@localhost:5433/zal",
        TORRSERVER_URL: "http://127.0.0.1:7002",
        TORRSERVER_PUBLIC_URL: "http://94.103.1.126",
        JWT_SECRET: "super-secret-jwt-key-kinopap-production-32-chars",
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
        PORT: 7000,
        NEXT_PUBLIC_API_URL: "http://94.103.1.126",
        INTERNAL_API_URL: "http://127.0.0.1:7001",
      },
    },
  ],
};
