/** Подборки: постановка тайтлов и позиции в конце списка. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  addItemToList,
  createUser,
  createUserList,
  getDefaultProfile,
  getUserList,
  hashPassword,
  listEntries,
  removeItemFromList,
} from "../src";
import { createTestDb, seedFixtures } from "./helpers";

type Db = Awaited<ReturnType<typeof createTestDb>>;

async function makeProfile(db: Db, email: string) {
  const user = await createUser(db, {
    email,
    passwordHash: await hashPassword("password-123"),
    name: email.split("@")[0]!,
  });
  return getDefaultProfile(db, user.id);
}

describe("addItemToList", () => {
  it("параллельные вставки не дают дублей позиций", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const profile = await makeProfile(db, "lists@zal.local");
    const list = await createUserList(db, profile.id, { title: "Хочу посмотреть" });

    // Гонка max(position)+1: раньше обе вставки читали одинаковый max
    // и получали одинаковую позицию. PGlite сериализует транзакции
    // очередью, но контракт (уникальные позиции) проверяем честно.
    const results = await Promise.all([
      addItemToList(db, profile.id, list.id, f.matrix),
      addItemToList(db, profile.id, list.id, f.reloaded),
      addItemToList(db, profile.id, list.id, f.got),
    ]);
    expect(results).toEqual([true, true, true]);

    const entries = await db
      .select({ itemId: listEntries.itemId, position: listEntries.position })
      .from(listEntries)
      .where(eq(listEntries.listId, list.id));
    expect(entries.map((e) => e.itemId).sort((a, b) => a - b)).toEqual(
      [f.matrix, f.reloaded, f.got].sort((a, b) => a - b),
    );
    expect(new Set(entries.map((e) => e.position)).size).toBe(3);

    const detail = await getUserList(db, profile.id, list.id);
    expect(detail!.items).toHaveLength(3);
  });

  it("последовательные добавления нумеруют позиции по порядку", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const profile = await makeProfile(db, "seq@zal.local");
    const list = await createUserList(db, profile.id, { title: "По порядку" });

    await addItemToList(db, profile.id, list.id, f.matrix);
    await addItemToList(db, profile.id, list.id, f.reloaded);
    await addItemToList(db, profile.id, list.id, f.got);

    const positions = await db
      .select({ itemId: listEntries.itemId, position: listEntries.position })
      .from(listEntries)
      .where(eq(listEntries.listId, list.id))
      .orderBy(listEntries.position);
    expect(positions.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it("явная позиция перезаписывается, удаление освобождает место", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const profile = await makeProfile(db, "explicit@zal.local");
    const list = await createUserList(db, profile.id, { title: "С местом" });

    await addItemToList(db, profile.id, list.id, f.matrix, 5);
    // Повтор с другой позицией — upsert, не вторая строка.
    await addItemToList(db, profile.id, list.id, f.matrix, 7);
    // После удаления добавление в конец не наследует старую позицию.
    expect(await removeItemFromList(db, profile.id, list.id, f.matrix)).toBe(true);
    await addItemToList(db, profile.id, list.id, f.reloaded);

    const positions = await db
      .select({ itemId: listEntries.itemId, position: listEntries.position })
      .from(listEntries)
      .where(eq(listEntries.listId, list.id));
    expect(positions).toEqual([{ itemId: f.reloaded, position: 0 }]);
  });

  it("чужая подборка отклоняется", async () => {
    const db = await createTestDb();
    const f = await seedFixtures(db);
    const owner = await makeProfile(db, "owner@zal.local");
    const intruder = await makeProfile(db, "intruder@zal.local");
    const list = await createUserList(db, owner.id, { title: "Личное" });

    expect(await addItemToList(db, intruder.id, list.id, f.matrix)).toBe(false);
    const entries = await db.select().from(listEntries);
    expect(entries).toHaveLength(0);
  });
});
