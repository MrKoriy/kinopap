/**
 * Уведомления о новых сериях: каналы пользователя (Telegram, web push),
 * привязка Telegram одноразовым кодом и выборка «что нового по подпискам»
 * для рассылки воркером. Плюс лента ошибок (error_events) для Ops и алертов.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db";
import { errorEvents, notifyChannels, notifyLinkCodes, subscriptions, users } from "../schema/index";

export type NotifyKind = "telegram" | "webpush";

export interface NotifyChannelDto {
  id: number;
  kind: NotifyKind;
  label: string | null;
  createdAt: string;
}

export interface NotifyTarget {
  id: number;
  userId: number;
  kind: NotifyKind;
  target: string;
  keys: { p256dh: string; auth: string } | null;
}

const LINK_TTL_MS = 15 * 60 * 1000;

/** Код для ссылки t.me/<bot>?start=<code>: живёт 15 минут, у пользователя один. */
export async function createTelegramLinkCode(db: Db, userId: number, now = new Date()): Promise<string> {
  const code = randomBytes(12).toString("hex");
  await db.delete(notifyLinkCodes).where(eq(notifyLinkCodes.userId, userId));
  await db.insert(notifyLinkCodes).values({ code, userId, expiresAt: new Date(now.getTime() + LINK_TTL_MS) });
  return code;
}

/** /start <code> из бота: код валиден → чат привязан к пользователю. null — код неизвестен или протух. */
export async function consumeTelegramLinkCode(
  db: Db,
  code: string,
  chatId: string,
  label: string | null,
  now = new Date(),
): Promise<number | null> {
  const [row] = await db
    .delete(notifyLinkCodes)
    .where(and(eq(notifyLinkCodes.code, code.slice(0, 32)), gt(notifyLinkCodes.expiresAt, now)))
    .returning({ userId: notifyLinkCodes.userId });
  if (!row) return null;
  await db
    .insert(notifyChannels)
    .values({ userId: row.userId, kind: "telegram", target: chatId, label })
    .onConflictDoUpdate({
      target: [notifyChannels.kind, notifyChannels.target],
      set: { userId: row.userId, label, createdAt: now },
    });
  return row.userId;
}

export async function addWebPushChannel(
  db: Db,
  userId: number,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  label: string | null,
): Promise<NotifyChannelDto> {
  const [row] = await db
    .insert(notifyChannels)
    .values({ userId, kind: "webpush", target: sub.endpoint, keys: sub.keys, label })
    .onConflictDoUpdate({
      target: [notifyChannels.kind, notifyChannels.target],
      set: { userId, keys: sub.keys, label },
    })
    .returning();
  return toDto(row!);
}

function toDto(r: typeof notifyChannels.$inferSelect): NotifyChannelDto {
  return { id: r.id, kind: r.kind as NotifyKind, label: r.label, createdAt: r.createdAt.toISOString() };
}

export async function listNotifyChannels(db: Db, userId: number): Promise<NotifyChannelDto[]> {
  const rows = await db
    .select()
    .from(notifyChannels)
    .where(eq(notifyChannels.userId, userId))
    .orderBy(desc(notifyChannels.createdAt));
  return rows.map(toDto);
}

export async function deleteNotifyChannel(db: Db, userId: number, id: number): Promise<boolean> {
  const rows = await db
    .delete(notifyChannels)
    .where(and(eq(notifyChannels.userId, userId), eq(notifyChannels.id, id)))
    .returning({ id: notifyChannels.id });
  return rows.length > 0;
}

/** Канал умер у провайдера (бот заблокирован, push-подписка 410) — забываем. */
export async function dropNotifyTarget(db: Db, kind: NotifyKind, target: string): Promise<void> {
  await db.delete(notifyChannels).where(and(eq(notifyChannels.kind, kind), eq(notifyChannels.target, target)));
}

export async function listTargetsForUsers(db: Db, userIds: number[]): Promise<NotifyTarget[]> {
  if (userIds.length === 0) return [];
  const rows = await db.select().from(notifyChannels).where(inArray(notifyChannels.userId, userIds));
  return rows.map((r) => ({ id: r.id, userId: r.userId, kind: r.kind as NotifyKind, target: r.target, keys: r.keys ?? null }));
}

/** Каналы владельца и админов — для алертов Ops. */
export async function listStaffTargets(db: Db): Promise<NotifyTarget[]> {
  const staff = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.role, ["owner", "admin"]), eq(users.isActive, true)));
  return listTargetsForUsers(
    db,
    staff.map((s) => s.id),
  );
}

export interface PendingEpisodeNotice {
  subscriptionId: number;
  userId: number;
  itemId: number;
  itemTitle: string;
  count: number;
  mediaId: number;
  season: number;
  episode: number;
}

/**
 * Подписки с новыми сериями после notified_at. «Новая» — media появилась
 * или серия вышла (air_date) после прошлой рассылки, и вышла уже: анонсы
 * будущих серий TMDb не дёргают людей заранее. Только у кого есть канал.
 */
export async function listPendingEpisodeNotices(db: Db, limit = 200, now = new Date()): Promise<PendingEpisodeNotice[]> {
  const res = await db.execute<{
    sub_id: number;
    user_id: number;
    item_id: number;
    title: string;
    n: number;
    media_id: number;
    season: number;
    episode: number;
  }>(sql`
    select s.id as sub_id, p.user_id, s.item_id, i.title, count(*)::int as n,
      (array_agg(m.id order by se.number, e.number))[1] as media_id,
      (array_agg(se.number order by se.number, e.number))[1] as season,
      (array_agg(e.number order by se.number, e.number))[1] as episode
    from subscriptions s
    join profiles p on p.id = s.profile_id
    join items i on i.id = s.item_id
    join media m on m.item_id = s.item_id and m.episode_id is not null
    join episodes e on e.id = m.episode_id
    join seasons se on se.id = e.season_id and se.number > 0
    where s.notify
      and greatest(m.created_at, coalesce(e.air_date, m.created_at)) > s.notified_at
      and (e.air_date is null or e.air_date <= ${now})
      and exists (select 1 from notify_channels c where c.user_id = p.user_id)
    group by s.id, p.user_id, s.item_id, i.title
    order by s.id
    limit ${limit}
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    subscriptionId: Number(r.sub_id),
    userId: Number(r.user_id),
    itemId: Number(r.item_id),
    itemTitle: String(r.title),
    count: Number(r.n),
    mediaId: Number(r.media_id),
    season: Number(r.season),
    episode: Number(r.episode),
  }));
}

export async function markSubscriptionsNotified(db: Db, ids: number[], at = new Date()): Promise<void> {
  if (ids.length === 0) return;
  await db.update(subscriptions).set({ notifiedAt: at }).where(inArray(subscriptions.id, ids));
}

/* ---------- Ошибки ---------- */

export interface ErrorInput {
  source: "web" | "api" | "worker";
  message: string;
  stack?: string | null;
  page?: string | null;
  release?: string | null;
}

/** Отпечаток: источник + текст без чисел/id + первая строка стека. */
export function errorFingerprint(e: Pick<ErrorInput, "source" | "message" | "stack">): string {
  const msg = e.message.replace(/\d+/g, "#").replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
  const frame = (e.stack ?? "").split("\n").find((l) => /^\s*at |@/.test(l))?.trim().replace(/:\d+:\d+\)?$/, "") ?? "";
  return createHash("sha1").update(`${e.source}|${msg}|${frame}`).digest("hex");
}

export async function recordError(db: Db, e: ErrorInput, now = new Date()): Promise<void> {
  const fingerprint = errorFingerprint(e);
  await db
    .insert(errorEvents)
    .values({
      source: e.source,
      fingerprint,
      message: e.message.slice(0, 2000),
      stack: e.stack?.slice(0, 8000) ?? null,
      page: e.page?.slice(0, 200) ?? null,
      release: e.release?.slice(0, 64) ?? null,
      firstSeen: now,
      lastSeen: now,
    })
    .onConflictDoUpdate({
      target: [errorEvents.source, errorEvents.fingerprint],
      set: { count: sql`${errorEvents.count} + 1`, lastSeen: now, page: e.page?.slice(0, 200) ?? null },
    });
}

export interface ErrorEventDto {
  id: number;
  source: string;
  message: string;
  stack: string | null;
  page: string | null;
  release: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export async function listRecentErrors(db: Db, hours = 24, limit = 50): Promise<ErrorEventDto[]> {
  const since = new Date(Date.now() - hours * 3600_000);
  const rows = await db
    .select()
    .from(errorEvents)
    .where(gt(errorEvents.lastSeen, since))
    .orderBy(desc(errorEvents.lastSeen))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    message: r.message,
    stack: r.stack,
    page: r.page,
    release: r.release,
    count: r.count,
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
  }));
}

/** Новые отпечатки (first_seen) за окно — повод для алерта. */
export async function newErrorsSince(db: Db, since: Date): Promise<ErrorEventDto[]> {
  const rows = await db.select().from(errorEvents).where(gt(errorEvents.firstSeen, since)).orderBy(desc(errorEvents.count)).limit(20);
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    message: r.message,
    stack: r.stack,
    page: r.page,
    release: r.release,
    count: r.count,
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
  }));
}

export async function purgeErrors(db: Db, days = 30): Promise<number> {
  const rows = await db
    .delete(errorEvents)
    .where(lt(errorEvents.lastSeen, new Date(Date.now() - days * 86_400_000)))
    .returning({ id: errorEvents.id });
  return rows.length;
}
