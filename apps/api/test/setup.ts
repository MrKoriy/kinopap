import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { type Db, migrationsDir, schema } from "@zal/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { IngestQueue } from "../src/ingest-queue";

export async function createTestApp(
  opts: { queue?: IngestQueue; env?: Record<string, string> } = {},
) {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsDir });

  const config = loadConfig({
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-secret-0123456789abcdef-0123456789",
    MEDIA_BASE_URL: "http://cdn.test/m",
    CORS_ORIGIN: "*",
    ...opts.env,
  });

  const app = await buildApp({ db, config, queue: opts.queue });
  return { app, db: db as unknown as Db };
}
