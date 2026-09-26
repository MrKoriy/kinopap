/**
 * Начальное наполнение: owner-аккаунт, стартовые инвайты, жанры и страны.
 * Контент (items) не сидируется — он приходит через ingest (фаза 2).
 */
import type { Db } from "./db";
import { countries, genres, invites } from "./schema/index";
import {
  createInvite,
  createProfile,
  createUser,
  findUserByEmail,
  type InviteRow,
  type UserRow,
} from "./repos/accounts";

const GENRES: { type: "movie" | "music" | "docu" | "tvshow"; title: string }[] = [
  { type: "movie", title: "Комедия" },
  { type: "movie", title: "Драма" },
  { type: "movie", title: "Боевик" },
  { type: "movie", title: "Фантастика" },
  { type: "movie", title: "Триллер" },
  { type: "movie", title: "Ужасы" },
  { type: "movie", title: "Мелодрама" },
  { type: "movie", title: "Детектив" },
  { type: "movie", title: "Приключения" },
  { type: "movie", title: "Мультфильм" },
  { type: "movie", title: "Документальный" },
  { type: "movie", title: "Катастрофа" },
  { type: "music", title: "Рок" },
  { type: "music", title: "Поп" },
  { type: "music", title: "Классика" },
  { type: "docu", title: "История" },
  { type: "docu", title: "Наука" },
  { type: "tvshow", title: "Реалити" },
  { type: "tvshow", title: "Ток-шоу" },
];

const COUNTRIES = [
  "США",
  "Россия",
  "Великобритания",
  "Франция",
  "Германия",
  "Италия",
  "Испания",
  "Япония",
  "Корея",
  "Китай",
  "Индия",
  "Канада",
  "Австралия",
  "Швеция",
  "Дания",
];

export interface SeedInput {
  ownerEmail: string;
  ownerName?: string;
  ownerPasswordHash: string;
  inviteCount?: number;
}

export interface SeedResult {
  owner: UserRow;
  invites: InviteRow[];
}

/** Идемпотентно: повторный запуск не дублирует данные. */
export async function seed(db: Db, input: SeedInput): Promise<SeedResult> {
  let owner = await findUserByEmail(db, input.ownerEmail);
  if (!owner) {
    owner = await createUser(db, {
      email: input.ownerEmail,
      passwordHash: input.ownerPasswordHash,
      name: input.ownerName ?? "Owner",
      role: "owner",
    });
    await createProfile(db, { userId: owner.id, name: input.ownerName ?? "Owner" });
  }

  await db
    .insert(genres)
    .values(GENRES)
    .onConflictDoNothing({ target: [genres.type, genres.title] });

  await db
    .insert(countries)
    .values(COUNTRIES.map((title) => ({ title })))
    .onConflictDoNothing({ target: [countries.title] });

  // Инвайты — только при первом запуске, иначе копим мусор.
  const existing = await db.select({ id: invites.id }).from(invites).limit(1);
  const created: InviteRow[] = [];
  if (existing.length === 0) {
    for (let i = 0; i < (input.inviteCount ?? 3); i++) {
      created.push(await createInvite(db, { createdBy: owner.id, maxUses: 1 }));
    }
  }

  return { owner, invites: created };
}
