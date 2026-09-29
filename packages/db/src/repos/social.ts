/**
 * Социальный слой: подписки на новые серии, дерево комментариев, голосование.
 * Голоса суммируем в items (votes_positive/votes_negative), рейтинг —
 * доля «за» от всех голосов, шкала 0..10.
 */

import type {
  CommentDto,
  NewEpisodeDto,
  SubscriptionDto,
  VoteStateDto,
} from "@zal/api-client";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  comments,
  episodes,
  items,
  media,
  profiles,
  seasons,
  subscriptions,
  users,
  votes,
  watchProgress,
} from "../schema/index";

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export interface NewEpisodesFeed {
  items: NewEpisodeDto[];
  /** Всего недосмотренных новинок (для badge в шапке). */
  total: number;
}
export type CommentRow = typeof comments.$inferSelect;
export type VoteRow = typeof votes.$inferSelect;

/** Максимальная глубина вложенности ответов (дальше отвечаем на уровень ниже). */
export const MAX_COMMENT_DEPTH = 6;

/** Потолок сканирования подписочной ленты (см. listNewEpisodes). */
const NEW_EPISODES_SCAN_CAP = 500;

/* ---------- Подписки ---------- */

function mapSubscription(
  row: SubscriptionRow,
  item: {
    id: number;
    type: SubscriptionDto["item"]["type"];
    title: string;
    year: number | null;
    posterMedium: string | null;
  },
): SubscriptionDto {
  return {
    itemId: row.itemId,
    notify: row.notify,
    createdAt: row.createdAt.toISOString(),
    item,
  };
}

export async function getSubscription(
  db: Db,
  profileId: number,
  itemId: number,
): Promise<SubscriptionDto | null> {
  const rows = await db
    .select({
      row: subscriptions,
      item: {
        id: items.id,
        type: items.type,
        title: items.title,
        year: items.year,
        posterMedium: items.posterMedium,
      },
    })
    .from(subscriptions)
    .innerJoin(items, eq(items.id, subscriptions.itemId))
    .where(
      and(eq(subscriptions.profileId, profileId), eq(subscriptions.itemId, itemId)),
    )
    .limit(1);
  return rows[0] ? mapSubscription(rows[0].row, rows[0].item) : null;
}

/** Подписка идемпотентна: повторный вызов обновляет notify. */
export async function upsertSubscription(
  db: Db,
  profileId: number,
  itemId: number,
  notify: boolean,
): Promise<SubscriptionDto> {
  await db
    .insert(subscriptions)
    .values({ profileId, itemId, notify })
    .onConflictDoUpdate({
      target: [subscriptions.profileId, subscriptions.itemId],
      set: { notify },
    });
  return (await getSubscription(db, profileId, itemId))!;
}

export async function deleteSubscription(
  db: Db,
  profileId: number,
  itemId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(subscriptions)
    .where(and(eq(subscriptions.profileId, profileId), eq(subscriptions.itemId, itemId)))
    .returning({ id: subscriptions.id });
  return deleted.length > 0;
}

export async function listSubscriptions(
  db: Db,
  profileId: number,
): Promise<SubscriptionDto[]> {
  const rows = await db
    .select({
      row: subscriptions,
      item: {
        id: items.id,
        type: items.type,
        title: items.title,
        year: items.year,
        posterMedium: items.posterMedium,
      },
    })
    .from(subscriptions)
    .innerJoin(items, eq(items.id, subscriptions.itemId))
    .where(eq(subscriptions.profileId, profileId))
    .orderBy(desc(subscriptions.createdAt));
  return rows.map((r) => mapSubscription(r.row, r.item));
}

const NOT_WATCHED = or(
  isNull(watchProgress.status),
  ne(watchProgress.status, "watched"),
);

const WATCHED_JOIN = and(
  eq(watchProgress.mediaId, media.id),
  eq(watchProgress.profileId, subscriptions.profileId),
);

/**
 * Лента «новое по подпискам»: недосмотренные серии сериалов и новые
 * части фильмов (partNumber > 1). Свежие сверху, total — для badge.
 *
 * scanCap — потолок сканирования (вынесен параметром для тестов).
 * orderBy до limit обязателен: без него limit срезал произвольные
 * строки, и самые свежие серии могли выпасть ещё до JS-сортировки.
 */
export async function listNewEpisodes(
  db: Db,
  profileId: number,
  limit = 20,
  scanCap = NEW_EPISODES_SCAN_CAP,
): Promise<NewEpisodesFeed> {  const epRows = await db
    .select({
      itemId: items.id,
      itemTitle: items.title,
      mediaId: media.id,
      seasonNumber: seasons.number,
      episodeNumber: episodes.number,
      episodeTitle: episodes.title,
      partNumber: media.partNumber,
      title: media.title,
      runtime: episodes.runtime,
      publishedAt: media.createdAt,
    })
    .from(subscriptions)
    .innerJoin(items, eq(items.id, subscriptions.itemId))
    .innerJoin(media, and(eq(media.itemId, items.id), sql`${media.episodeId} is not null`))
    .innerJoin(episodes, eq(episodes.id, media.episodeId))
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .leftJoin(watchProgress, WATCHED_JOIN)
    .where(and(eq(subscriptions.profileId, profileId), NOT_WATCHED))
    // Раньше оба запроса тянули ВСЮ ленту подписок в память ради total —
    // на большой библиотеке это O(все media) на каждый запрос. Потолок
    // достаточен для ленты: total = min(реальный, потолок).
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(scanCap);

  const partRows = await db
    .select({
      itemId: items.id,
      itemTitle: items.title,
      mediaId: media.id,
      partNumber: media.partNumber,
      title: media.title,
      runtime: media.runtime,
      publishedAt: media.createdAt,
    })
    .from(subscriptions)
    .innerJoin(items, eq(items.id, subscriptions.itemId))
    .innerJoin(
      media,
      and(eq(media.itemId, items.id), isNull(media.episodeId), gt(media.partNumber, 1)),
    )
    .leftJoin(watchProgress, WATCHED_JOIN)
    .where(and(eq(subscriptions.profileId, profileId), NOT_WATCHED))
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(scanCap);

  const merged: NewEpisodeDto[] = [
    ...epRows.map((r) => ({
      kind: "episode" as const,
      itemId: r.itemId,
      itemTitle: r.itemTitle,
      mediaId: r.mediaId,
      seasonNumber: r.seasonNumber,
      episodeNumber: r.episodeNumber,
      episodeTitle: r.episodeTitle,
      partNumber: null,
      title: null,
      runtime: r.runtime,
      publishedAt: r.publishedAt.toISOString(),
    })),
    ...partRows.map((r) => ({
      kind: "part" as const,
      itemId: r.itemId,
      itemTitle: r.itemTitle,
      mediaId: r.mediaId,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: null,
      partNumber: r.partNumber,
      title: r.title,
      runtime: r.runtime,
      publishedAt: r.publishedAt.toISOString(),
    })),
  ].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  return { items: merged.slice(0, limit), total: merged.length };
}

/* ---------- Голосование ---------- */

function ratingOf(positive: number, total: number): number {
  return total > 0 ? Math.round((10 * positive) / total * 10) / 10 : 0;
}

async function voteState(
  db: Db,
  profileId: number | null,
  itemId: number,
): Promise<VoteStateDto> {
  const itemRows = await db
    .select({ positive: items.votesPositive, negative: items.votesNegative })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  const mine = profileId
    ? await db
        .select()
        .from(votes)
        .where(and(eq(votes.profileId, profileId), eq(votes.itemId, itemId)))
        .limit(1)
    : [];
  return {
    itemId,
    myVote: mine[0] ? mine[0].positive : null,
    votes: {
      positive: itemRows[0]?.positive ?? 0,
      negative: itemRows[0]?.negative ?? 0,
      total: (itemRows[0]?.positive ?? 0) + (itemRows[0]?.negative ?? 0),
    },
  };
}

/** Голос за/против; повторный тем же голосом — no-op, смена — перевес. */
export async function setVote(
  db: Db,
  profileId: number,
  itemId: number,
  positive: boolean,
): Promise<VoteStateDto> {
  await db.transaction(async (tx) => {
    const mine = await tx
      .select()
      .from(votes)
      .where(and(eq(votes.profileId, profileId), eq(votes.itemId, itemId)))
      .limit(1);
    const prev = mine[0] ?? null;
    if (prev && prev.positive === positive) return;

    const dPos = (positive ? 1 : 0) - (prev ? (prev.positive ? 1 : 0) : 0);
    const dNeg = (positive ? 0 : 1) - (prev ? (prev.positive ? 0 : 1) : 0);

    if (prev) {
      await tx
        .update(votes)
        .set({ positive, updatedAt: new Date() })
        .where(eq(votes.id, prev.id));
    } else {
      await tx.insert(votes).values({ profileId, itemId, positive });
    }

    await tx
      .update(items)
      .set({
        votesPositive: sql`${items.votesPositive} + ${dPos}`,
        votesNegative: sql`${items.votesNegative} + ${dNeg}`,
      })
      .where(eq(items.id, itemId));

    const totals = await tx
      .select({ positive: items.votesPositive, negative: items.votesNegative })
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1);
    const t = totals[0];
    if (t) {
      await tx
        .update(items)
        .set({ rating: ratingOf(t.positive, t.positive + t.negative) })
        .where(eq(items.id, itemId));
    }
  });
  return voteState(db, profileId, itemId);
}

/** Снятие голоса: счётчики и рейтинг пересчитываются. */
export async function removeVote(
  db: Db,
  profileId: number,
  itemId: number,
): Promise<VoteStateDto> {
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(votes)
      .where(and(eq(votes.profileId, profileId), eq(votes.itemId, itemId)))
      .returning();
    const prev = deleted[0];
    if (!prev) return;

    await tx
      .update(items)
      .set({
        votesPositive: sql`${items.votesPositive} - ${prev.positive ? 1 : 0}`,
        votesNegative: sql`${items.votesNegative} - ${prev.positive ? 0 : 1}`,
      })
      .where(eq(items.id, itemId));

    const totals = await tx
      .select({ positive: items.votesPositive, negative: items.votesNegative })
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1);
    const t = totals[0];
    if (t) {
      await tx
        .update(items)
        .set({ rating: ratingOf(t.positive, t.positive + t.negative) })
        .where(eq(items.id, itemId));
    }
  });
  return voteState(db, profileId, itemId);
}

export async function getVoteState(
  db: Db,
  profileId: number | null,
  itemId: number,
): Promise<VoteStateDto | null> {
  const itemRows = await db.select({ id: items.id }).from(items).where(eq(items.id, itemId)).limit(1);
  if (!itemRows[0]) return null;
  return voteState(db, profileId, itemId);
}

/* ---------- Комментарии ---------- */

interface CommentJoinRow {
  row: CommentRow;
  author: { id: number; name: string };
}

/** author.id — id аккаунта (для «мой комментарий»), имя — из профиля. */
function mapComment(row: CommentRow, author: { id: number; name: string }): CommentDto {
  return {
    id: row.id,
    itemId: row.itemId,
    parentId: row.parentId,
    depth: row.depth,
    body: row.deleted ? "" : row.body,
    deleted: row.deleted,
    author,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const commentJoin = {
  row: comments,
  author: { id: users.id, name: profiles.name },
};

const commentFrom = (db: Db) =>
  db
    .select(commentJoin)
    .from(comments)
    .innerJoin(profiles, eq(profiles.id, comments.profileId))
    .innerJoin(users, eq(users.id, profiles.userId));

/** Плоский список в порядке создания — дерево собирает клиент. */
export async function listComments(db: Db, itemId: number): Promise<CommentDto[]> {
  const rows: CommentJoinRow[] = await commentFrom(db)
    .where(eq(comments.itemId, itemId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return rows.map((r) => mapComment(r.row, r.author));
}

/**
 * Постранично по корневым веткам: страница — корни целиком со всеми
 * ответами. Ветвь собирается одним recursive CTE (раньше — по запросу
 * на каждый уровень глубины). nextOffset — смещение следующей страницы
 * веток, null — конец.
 */
export async function listCommentsPage(
  db: Db,
  itemId: number,
  limit: number,
  offset: number,
): Promise<{ items: CommentDto[]; nextOffset: number | null; total: number }> {
  const [rootRows, countRows] = await Promise.all([
    db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.itemId, itemId), isNull(comments.parentId)))
      .orderBy(asc(comments.createdAt), asc(comments.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(eq(comments.itemId, itemId), isNull(comments.parentId))),
  ]);
  const total = countRows[0]?.n ?? 0;
  const roots = rootRows.map((r) => r.id);
  const nextOffset = offset + roots.length < total ? offset + roots.length : null;
  if (!roots.length) return { items: [], nextOffset: null, total };

  // Рекурсивный CTE: корни страницы + всё их поддерево одним запросом.
  // PGlite/drizzle: raw SQL с параметрами, склейка id-листа безопасна
  // (числа из только что выбранных строк).
  const rootList = sql.join(roots.map((id) => sql`${id}`), sql`, `);
  const branchRows = await db.execute(sql`
    with recursive branch(id) as (
      select id from ${comments} where id in (${rootList})
      union all
      select c.id
      from ${comments} c
      join branch b on c.parent_id = b.id
      where c.item_id = ${itemId}
    )
    select id from branch
  `);
  const ids = (branchRows.rows as unknown as Array<{ id: number | string }>).map((r) =>
    Number(r.id),
  );

  const rows: CommentJoinRow[] = await commentFrom(db)
    .where(inArray(comments.id, ids))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return {
    items: rows.map((r) => mapComment(r.row, r.author)),
    nextOffset,
    total,
  };
}

export async function countComments(db: Db, itemId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(comments)
    .where(and(eq(comments.itemId, itemId), eq(comments.deleted, false)));
  return rows[0]?.n ?? 0;
}

export async function getComment(db: Db, id: number): Promise<CommentDto | null> {
  const rows: CommentJoinRow[] = await commentFrom(db)
    .where(eq(comments.id, id))
    .limit(1);
  return rows[0] ? mapComment(rows[0].row, rows[0].author) : null;
}

/**
 * Новый комментарий: ответ привязывается к родителю того же тайтла,
 * глубина зажимается MAX_COMMENT_DEPTH.
 */
/** Родительский комментарий не найден/чужой: доменная ошибка вместо
 * строкового сообщения (стринг-матч в роуте молча превращался в 500
 * при любом переименовании). */
export class ParentCommentNotFoundError extends Error {
  constructor() {
    super("parent_not_found");
    this.name = "ParentCommentNotFoundError";
  }
}

export async function addComment(
  db: Db,
  input: {
    itemId: number;
    profileId: number;
    parentId?: number | null;
    body: string;
  },
): Promise<CommentDto> {
  let depth = 0;
  if (input.parentId != null) {
    const parents = await db
      .select()
      .from(comments)
      .where(eq(comments.id, input.parentId))
      .limit(1);
    const parent = parents[0];
    if (!parent || parent.itemId !== input.itemId) {
      throw new ParentCommentNotFoundError();
    }
    depth = Math.min(parent.depth + 1, MAX_COMMENT_DEPTH);
  }

  const inserted = await db
    .insert(comments)
    .values({
      itemId: input.itemId,
      profileId: input.profileId,
      parentId: input.parentId ?? null,
      depth,
      body: input.body,
    })
    .returning();
  return (await getComment(db, inserted[0]!.id))!;
}

/** Редактирование: только живые комментарии, updatedAt перескакивает. */
export async function updateComment(
  db: Db,
  id: number,
  body: string,
): Promise<CommentDto | null> {
  const updated = await db
    .update(comments)
    .set({ body, updatedAt: new Date() })
    .where(and(eq(comments.id, id), eq(comments.deleted, false)))
    .returning({ id: comments.id });
  return updated.length ? getComment(db, id) : null;
}

/** Мягкое удаление: узел остаётся, чтобы дерево ответов не рассыпалось. */
export async function softDeleteComment(db: Db, id: number): Promise<boolean> {
  const updated = await db
    .update(comments)
    .set({ deleted: true, body: "" })
    .where(and(eq(comments.id, id), eq(comments.deleted, false)))
    .returning({ id: comments.id });
  return updated.length > 0;
}

/** Профиль автора комментария — для проверки прав (userId). */
export async function getCommentAuthorUserId(
  db: Db,
  id: number,
): Promise<number | null> {
  const rows = await db
    .select({ userId: profiles.userId })
    .from(comments)
    .innerJoin(profiles, eq(profiles.id, comments.profileId))
    .where(eq(comments.id, id))
    .limit(1);
  return rows[0]?.userId ?? null;
}
