/**
 * Смена пароля пользователя (в первую очередь владельца) с сервера — когда
 * войти в веб нельзя: пароль забыт или остался от сида.
 *
 *   NEW_PASSWORD='…' pnpm db:set-password --email=owner@example.com
 *   printf '%s' '…' | pnpm db:set-password --email=owner@example.com
 *
 * Без --email берётся владелец (role = owner). Пароль — из NEW_PASSWORD или
 * stdin, не аргументом: аргументы видны в `ps` и истории шелла. Все
 * refresh-токены пользователя отзываются — старые сессии выйдут.
 */
import { eq } from "drizzle-orm";
import { createDb, createPool } from "./db";
import { hashPassword } from "./password";
import { revokeAllUserTokens, setUserPasswordHash } from "./repos/accounts";
import { users } from "./schema/users";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const emailArg = process.argv.find((a) => a.startsWith("--email="))?.slice("--email=".length).trim();
  const password = process.env.NEW_PASSWORD || (await readStdin());
  if (password.length < 12) {
    throw new Error("новый пароль: минимум 12 символов (NEW_PASSWORD или stdin)");
  }

  const pool = createPool(databaseUrl);
  try {
    const db = createDb(pool);
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(emailArg ? eq(users.email, emailArg.toLowerCase()) : eq(users.role, "owner"))
      .limit(1);
    if (!user) throw new Error(emailArg ? `пользователь ${emailArg} не найден` : "владелец не найден");
    await setUserPasswordHash(db, user.id, await hashPassword(password));
    await revokeAllUserTokens(db, user.id);
    console.log(`password: обновлён для ${user.email}, сессии отозваны`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
