/**
 * dev-скрипт: миграции + seed.
 *   DATABASE_URL=... SEED_OWNER_EMAIL=... SEED_OWNER_PASSWORD=... pnpm db:setup
 */
import { createDb, createPool, runMigrations } from "./db";
import { hashPassword } from "./password";
import { seed } from "./seed";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const ownerEmail = process.env.SEED_OWNER_EMAIL ?? "owner@zal.local";
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? "change-me-owner";

  const pool = createPool(databaseUrl);
  await runMigrations(pool);
  console.log("migrations: ok");

  const db = createDb(pool);
  const result = await seed(db, {
    ownerEmail,
    ownerName: "Owner",
    ownerPasswordHash: await hashPassword(ownerPassword),
  });
  console.log(`seed: owner=${result.owner.email}`);
  for (const invite of result.invites) {
    console.log(`seed: invite ${invite.code}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
