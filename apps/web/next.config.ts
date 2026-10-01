import type { NextConfig } from "next";

const extraImageHosts = (process.env.NEXT_PUBLIC_EXTRA_IMAGE_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((hostname) => ({ protocol: "https" as const, hostname }));

const nextConfig: NextConfig = {
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
  },
};

export default nextConfig;
