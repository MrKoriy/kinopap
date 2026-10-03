/**
 * dev-скрипт: миграции + seed.
 *   DATABASE_URL=... SEED_OWNER_EMAIL=... SEED_OWNER_PASSWORD=... pnpm db:setup
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, createPool, runMigrations } from "./db";
import { hashPassword } from "./password";
import { users } from "./schema/users";
import { seed } from "./seed";

const DEV_OWNER_EMAIL = "owner@zal.local";
const DEV_OWNER_PASSWORD = "change-me-owner";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const isProd = process.env.NODE_ENV === "production" || process.env.ZAL_DEPLOY === "1";
  const envEmail = process.env.SEED_OWNER_EMAIL?.trim() || undefined;
  const envPassword = process.env.SEED_OWNER_PASSWORD || undefined;

  const pool = createPool(databaseUrl);
  await runMigrations(pool);
  console.log("migrations: ok");

  const db = createDb(pool);

  // Раньше без SEED_OWNER_* сид молча создавал owner@zal.local/change-me-owner —
  // в том числе на проде и даже рядом с уже существующим настоящим владельцем.
  // Теперь: владелец уже есть и env не задан → нового не создаём; владельца нет →
  // на проде требуем явные данные и нормальный пароль, дефолты только для dev.
  const [existingOwner] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.role, "owner"))
    .limit(1);

  if (isProd && existingOwner?.email === DEV_OWNER_EMAIL) {
    console.warn(
      "ВНИМАНИЕ: на проде есть владелец owner@zal.local — смените ему email и пароль (скорее всего change-me-owner)",
    );
  }

  let ownerEmail: string;
  let ownerPassword: string;
  if (envEmail) {
    ownerEmail = envEmail;
    ownerPassword = envPassword ?? "";
  } else if (existingOwner) {
    ownerEmail = existingOwner.email;
    // Пароль не используется: seed не трогает существующего пользователя.
    ownerPassword = randomBytes(24).toString("base64url");
  } else if (isProd) {
    await pool.end();
    throw new Error(
      "владельца нет, а SEED_OWNER_EMAIL/SEED_OWNER_PASSWORD не заданы — на проде дефолтного владельца не создаём",
    );
  } else {
    ownerEmail = DEV_OWNER_EMAIL;
    ownerPassword = DEV_OWNER_PASSWORD;
  }

  const creatingOwner = !existingOwner || existingOwner.email !== ownerEmail;
  if (creatingOwner && isProd && (ownerPassword.length < 12 || ownerPassword === DEV_OWNER_PASSWORD)) {
    await pool.end();
    throw new Error("SEED_OWNER_PASSWORD на проде должен быть не короче 12 символов и не дефолтным");
  }
  if (creatingOwner && !ownerPassword) {
    await pool.end();
    throw new Error("SEED_OWNER_PASSWORD обязателен вместе с SEED_OWNER_EMAIL");
  }

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
