import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
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
  const pool = new Pool({ connectionString: databaseUrl });
  // Без этого ошибка idle-клиента (рестарт PG, сетевой сброс) улетает в
  // unhandled 'error'-ивент и роняет весь процесс.
  pool.on("error", (err) => {
    console.error("pg pool: idle client error", err.message);
  });
  return pool;
}

/**
 * Каталог миграций drizzle-kit (лежит рядом с src).
 *
 * Из исходников (tsx, тесты) это `packages/db/drizzle`. В прод-бандле
 * API/воркера этот модуль вшит в `apps/<app>/dist/*.js`, и относительный
 * путь указал бы в никуда — тогда поднимаемся вверх до корня монорепо.
 * ZAL_MIGRATIONS_DIR перекрывает поиск явно.
 */
function resolveMigrationsDir(): string {
  const fromEnv = process.env.ZAL_MIGRATIONS_DIR;
  if (fromEnv) return fromEnv;
  const besideSrc = fileURLToPath(new URL("../drizzle", import.meta.url));
  if (existsSync(join(besideSrc, "meta", "_journal.json"))) return besideSrc;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "packages", "db", "drizzle");
    if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return besideSrc;
    dir = parent;
  }
}

export const migrationsDir = resolveMigrationsDir();

export async function runMigrations(pool: Pool): Promise<void> {
  const db = createDb(pool);
  await migrateNodePg(db, { migrationsFolder: migrationsDir });
}

export { schema };
