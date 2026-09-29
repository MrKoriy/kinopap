import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    // Дефолт только для локальной разработки; пароль намеренно не боевой.
    url: process.env.DATABASE_URL ?? "postgres://zal:dev@localhost:5432/zal",
  },
});
