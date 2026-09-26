import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace-пакеты отдаются исходниками TS — транспилируем их.
  transpilePackages: ["@zal/api-client", "@zal/ui"],
};

export default nextConfig;
