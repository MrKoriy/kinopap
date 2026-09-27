import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgres://zal:zal@localhost:5432/zal"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-me-32-chars-ok"),
  MEDIA_BASE_URL: z.string().default("http://localhost:9000/zal-media"),
  TORRSERVER_URL: z.string().default("http://localhost:8090"),
  TORRSERVER_PUBLIC_URL: z.string().optional(),
  PORT: z.coerce.number().int().default(3001),
  CORS_ORIGIN: z.string().default("*"),
});

export interface Config {
  databaseUrl: string;
  jwtSecret: string;
  mediaBaseUrl: string;
  torrServerUrl: string;
  torrServerPublicUrl?: string;
  port: number;
  corsOrigin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    mediaBaseUrl: e.MEDIA_BASE_URL,
    torrServerUrl: e.TORRSERVER_URL,
    torrServerPublicUrl: e.TORRSERVER_PUBLIC_URL,
    port: e.PORT,
    corsOrigin: e.CORS_ORIGIN,
  };
}
