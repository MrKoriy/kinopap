import path from "node:path";
import type { NextConfig } from "next";

const extraImageHosts = (process.env.NEXT_PUBLIC_EXTRA_IMAGE_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((hostname) => ({ protocol: "https" as const, hostname }));

const nextConfig: NextConfig = {
  // Прод: `node .next/standalone/apps/web/server.js` — минимальный сервер с
  // трассированными зависимостями вместо `next start` через pnpm. Корень
  // трассировки — монорепо: воркспейс-пакеты лежат выше apps/web.
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: ["@zal/api-client", "@zal/ui", "@zal/shared"],
  experimental: {
    optimizePackageImports: ["lucide-react", "motion"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org" },
      { protocol: "http", hostname: "localhost", port: "3001" },
      { protocol: "http", hostname: "127.0.0.1", port: "3001" },
      { protocol: "http", hostname: "localhost", port: "9000" },
      ...extraImageHosts,
    ],
    // Только для media-оптимизации локальных постеров — не открывает оптимизации чужих IP.
    dangerouslyAllowLocalIP: true,
    // AVIF на ~20–30% легче WebP; оба кэшируются и отдаются по Accept.
    formats: ["image/avif", "image/webp"],
    // Постеры TMDb по пути неизменяемы: месяц в кэше оптимизатора вместо
    // дефолтных 4 часов (кэш живёт в общей папке, переживает деплой).
    minimumCacheTTL: 60 * 60 * 24 * 30,
    // Реально используемые ширины: меньше вариантов — выше доля попаданий.
    deviceSizes: [640, 828, 1080, 1280, 1920],
    imageSizes: [96, 128, 160, 200, 256, 320, 384],
  },
};

export default nextConfig;
