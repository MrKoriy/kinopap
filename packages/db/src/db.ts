import { fileURLToPath } from "node:url";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema/index";

/**
 * Репозитории принимают любой drizzle-драйвер Postgres:
 * node-postgres (prod) или PGlite (тесты в памяти) — оба наследуют PgDatabase.
 * Типы результатов идут от таблиц, не от generic'ов драйвера.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, any, any>;

export function createDb(pool: Pool): NodePgDatabase<typeof schema> {
  return drizzleNodePg(pool, { schema });
}

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

/** Каталог миграций drizzle-kit (лежит рядом с src). */
export const migrationsDir = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function runMigrations(pool: Pool): Promise<void> {
  const db = createDb(pool);
  await migrateNodePg(db, { migrationsFolder: migrationsDir });
}

export { schema };
