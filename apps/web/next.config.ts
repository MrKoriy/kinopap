import type { NextConfig } from "next";

/** Дополнительные домены постеров (self-hosted storage) — через env, через запятую. */
const extraImageHosts = (process.env.NEXT_PUBLIC_EXTRA_IMAGE_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((hostname) => ({ protocol: "https" as const, hostname }));

const nextConfig: NextConfig = {
  // Workspace-пакеты отдаются исходниками TS — транспилируем их.
  transpilePackages: ["@zal/api-client", "@zal/ui", "@zal/shared"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org" },
      { protocol: "http", hostname: "localhost", port: "3001" },
      { protocol: "http", hostname: "127.0.0.1", port: "3001" },
      { protocol: "http", hostname: "localhost", port: "9000" },
      ...extraImageHosts,
    ],
    // Свой media-сервер живёт на localhost/LAN — оптимизатор Next по
    // умолчанию считает такие адреса SSRF-риском и отдаёт 400.
    dangerouslyAllowLocalIP: true,
  },
};

export default nextConfig;
