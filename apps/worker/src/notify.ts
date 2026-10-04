/**
 * Уведомления и алерты: своя очередь `notify`, не ждёт долгие задачи демона.
 *
 * | задача            | частота | что делает                                              |
 * | ----------------- | ------- | ------------------------------------------------------- |
 * | notify-episodes   | 10 мин  | новые серии по подпискам → Telegram и web push          |
 * | telegram-updates  | 15 с    | getUpdates бота: /start <code> привязывает чат, /stop   |
 * | ops-alerts        | 5 мин   | новые ошибки и застрявшие задачи → владельцу/админам     |
 *
 * Telegram включается TELEGRAM_BOT_TOKEN, web push — WEBPUSH_PUBLIC_KEY +
 * WEBPUSH_PRIVATE_KEY (deploy.sh генерирует пару сам). Мёртвые каналы
 * (бот заблокирован, push 404/410) удаляются при первой ошибке доставки.
 */
import {
  consumeTelegramLinkCode,
  type Db,
  dropNotifyTarget,
  getSyncState,
  listPendingEpisodeNotices,
  listStaffTargets,
  listSyncState,
  listTargetsForUsers,
  markSubscriptionsNotified,
  type NotifyTarget,
  newErrorsSince,
  purgeErrors,
  recordSyncRun,
} from "@zal/db";
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import webpush from "web-push";

export const NOTIFY_QUEUE = "notify";

export interface NotifyConfig {
  telegramToken?: string;
  webpush?: { publicKey: string; privateKey: string; subject: string };
  siteUrl: string;
}

export interface NotifyMessage {
  title: string;
  body: string;
  url: string;
}

export interface Senders {
  telegram: (chatId: string, text: string, buttonUrl?: string) => Promise<"ok" | "gone" | "error">;
  webpush: (t: NotifyTarget, msg: NotifyMessage) => Promise<"ok" | "gone" | "error">;
}

/* ---------- Доставка ---------- */

async function tgCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; result?: T; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  return { ok: !!json.ok, status: res.status, result: json.result, description: json.description };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function makeSenders(cfg: NotifyConfig): Senders {
  if (cfg.webpush) webpush.setVapidDetails(cfg.webpush.subject, cfg.webpush.publicKey, cfg.webpush.privateKey);
  return {
    telegram: async (chatId, text, buttonUrl) => {
      if (!cfg.telegramToken) return "error";
      try {
        const r = await tgCall(cfg.telegramToken, "sendMessage", {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(buttonUrl ? { reply_markup: { inline_keyboard: [[{ text: "▶ Смотреть", url: buttonUrl }]] } } : {}),
        });
        if (r.ok) return "ok";
        // 403: бот заблокирован/чат удалён; 400 chat not found — тоже навсегда.
        return r.status === 403 || /chat not found/i.test(r.description ?? "") ? "gone" : "error";
      } catch {
        return "error";
      }
    },
    webpush: async (t, msg) => {
      if (!cfg.webpush || !t.keys) return "error";
      try {
        await webpush.sendNotification({ endpoint: t.target, keys: t.keys }, JSON.stringify(msg), { TTL: 24 * 3600 });
        return "ok";
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        return status === 404 || status === 410 ? "gone" : "error";
      }
    },
  };
}

/** Сообщение одному пользователю по всем его каналам. */
async function deliver(db: Db, senders: Senders, targets: NotifyTarget[], msg: NotifyMessage): Promise<number> {
  let sent = 0;
  for (const t of targets) {
    const res =
      t.kind === "telegram"
        ? await senders.telegram(t.target, `<b>${escapeHtml(msg.title)}</b>\n${escapeHtml(msg.body)}`, msg.url)
        : await senders.webpush(t, msg);
    if (res === "ok") sent++;
    if (res === "gone") await dropNotifyTarget(db, t.kind, t.target).catch(() => undefined);
  }
  return sent;
}

/* ---------- Новые серии ---------- */

export function episodeMessage(
  n: { itemTitle: string; count: number; season: number; episode: number; itemId: number; mediaId: number },
  siteUrl: string,
): NotifyMessage {
  const what =
    n.count === 1
      ? `Вышла серия ${n.episode} (сезон ${n.season})`
      : `Новых серий: ${n.count} — с ${n.episode}-й серии ${n.season} сезона`;
  return { title: n.itemTitle, body: what, url: `${siteUrl.replace(/\/$/, "")}/watch/${n.itemId}/${n.mediaId}` };
}

export async function notifyNewEpisodes(db: Db, senders: Senders, cfg: NotifyConfig, now = new Date()) {
  const pending = await listPendingEpisodeNotices(db, 300, now);
  const targets = await listTargetsForUsers(db, [...new Set(pending.map((p) => p.userId))]);
  const byUser = new Map<number, NotifyTarget[]>();
  for (const t of targets) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);
  let sent = 0;
  for (const p of pending) sent += await deliver(db, senders, byUser.get(p.userId) ?? [], episodeMessage(p, cfg.siteUrl));
  // Отмечаем даже при сбое доставки: повтор через 10 минут засыпал бы
  // людей дублями, если упал только один из каналов.
  await markSubscriptionsNotified(db, pending.map((p) => p.subscriptionId), now);
  return { subscriptions: pending.length, sent };
}

/* ---------- Telegram: привязка ---------- */

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number; username?: string; first_name?: string }; text?: string };
}

export async function pollTelegram(db: Db, token: string, senders: Senders, fetchUpdates?: (offset: number) => Promise<TgUpdate[]>) {
  const state = await getSyncState(db, "telegram-updates");
  const offset = Number(state?.cursor ?? 0);
  const updates = fetchUpdates
    ? await fetchUpdates(offset)
    : ((await tgCall<TgUpdate[]>(token, "getUpdates", { offset, timeout: 0, allowed_updates: ["message"] })).result ?? []);
  let linked = 0;
  let next = offset;
  for (const u of updates) {
    next = Math.max(next, u.update_id + 1);
    const msg = u.message;
    if (!msg?.text) continue;
    const chatId = String(msg.chat.id);
    const [cmd, arg] = msg.text.trim().split(/\s+/, 2);
    if (cmd === "/start" && arg) {
      const label = msg.chat.username ? `@${msg.chat.username}` : (msg.chat.first_name ?? null);
      const userId = await consumeTelegramLinkCode(db, arg, chatId, label);
      if (userId) linked++;
      await senders.telegram(
        chatId,
        userId
          ? "✅ Готово! Пришлю сюда новые серии сериалов, на которые вы подписаны в kino.pap. Отключить — /stop."
          : "Ссылка устарела. Откройте «Подписки» на сайте и нажмите «Подключить Telegram» ещё раз.",
      );
    } else if (cmd === "/start") {
      await senders.telegram(chatId, "Чтобы получать уведомления, нажмите «Подключить Telegram» в разделе «Подписки» на сайте.");
    } else if (cmd === "/stop") {
      await dropNotifyTarget(db, "telegram", chatId);
      await senders.telegram(chatId, "Уведомления отключены. Вернуть — «Подключить Telegram» на сайте.");
    }
  }
  return { updates: updates.length, linked, cursor: String(next) };
}

/* ---------- Алерты ---------- */

/** Сколько можно не получать успешный прогон задачи, прежде чем бить тревогу. */
export const STALE_AFTER_MS: Record<string, number> = {
  "tmdb-changes": 3 * 3600_000,
  "anilibria-updates": 2 * 3600_000,
  "metadata-gaps": 4 * 3600_000,
  "tmdb-feeds": 12 * 3600_000,
  "gap-filler": 3 * 3600_000,
  "notify-episodes": 2 * 3600_000,
};

export async function opsAlerts(db: Db, senders: Senders, cfg: NotifyConfig, now = new Date()) {
  const state = await getSyncState(db, "ops-alerts");
  const since = state?.cursor ? new Date(state.cursor) : new Date(now.getTime() - 10 * 60_000);
  const prevStale = new Set<string>(((state?.stats as { stale?: string[] } | null)?.stale ?? []) as string[]);

  const lines: string[] = [];
  const fresh = await newErrorsSince(db, since);
  if (fresh.length > 0) {
    lines.push(`Новые ошибки (${fresh.length}):`);
    for (const e of fresh.slice(0, 5)) lines.push(`• [${e.source}] ${e.message.slice(0, 140)}${e.page ? ` — ${e.page}` : ""} ×${e.count}`);
  }
  const stale: string[] = [];
  for (const s of await listSyncState(db)) {
    const limit = STALE_AFTER_MS[s.key];
    if (!limit) continue;
    const ok = s.lastOkAt ? new Date(s.lastOkAt).getTime() : 0;
    if (now.getTime() - ok > limit) stale.push(s.key);
  }
  const newlyStale = stale.filter((k) => !prevStale.has(k));
  const recovered = [...prevStale].filter((k) => !stale.includes(k));
  if (newlyStale.length) lines.push(`Задачи давно не проходят: ${newlyStale.join(", ")}`);
  if (recovered.length) lines.push(`✅ Снова в норме: ${recovered.join(", ")}`);

  let sent = 0;
  if (lines.length > 0) {
    const targets = await listStaffTargets(db);
    sent = await deliver(db, senders, targets, { title: "⚠️ kino.pap", body: lines.join("\n"), url: `${cfg.siteUrl.replace(/\/$/, "")}/ops` });
  }
  const purged = await purgeErrors(db, 30).catch(() => 0);
  return { stats: { newErrors: fresh.length, stale, sent, purged }, cursor: now.toISOString() };
}

/* ---------- Расписание ---------- */

type TaskId = "notify-episodes" | "telegram-updates" | "ops-alerts";

export function notifySchedules(cfg: NotifyConfig): Array<{ id: TaskId; everyMs: number }> {
  return [
    { id: "notify-episodes" as const, everyMs: 10 * 60_000 },
    ...(cfg.telegramToken ? [{ id: "telegram-updates" as const, everyMs: 15_000 }] : []),
    { id: "ops-alerts" as const, everyMs: 5 * 60_000 },
  ];
}

export async function runNotifyTask(db: Db, cfg: NotifyConfig, senders: Senders, id: TaskId) {
  try {
    if (id === "telegram-updates") {
      const r = await pollTelegram(db, cfg.telegramToken!, senders);
      // Пустые опросы раз в 15 с в sync_state не пишем — только курсор при движении.
      if (r.updates > 0) await recordSyncRun(db, id, { ok: true, cursor: r.cursor, stats: { linked: r.linked, updates: r.updates } });
      return r;
    }
    const res: { stats: Record<string, unknown>; cursor?: string } =
      id === "notify-episodes" ? { stats: await notifyNewEpisodes(db, senders, cfg) } : await opsAlerts(db, senders, cfg);
    await recordSyncRun(db, id, { ok: true, cursor: res.cursor, stats: res.stats });
    if (id === "notify-episodes" && Number(res.stats.subscriptions) > 0) console.log(`notify: ${JSON.stringify(res.stats)}`);
    return res.stats;
  } catch (err) {
    const msg = String(err).slice(0, 500);
    console.warn(`notify: ${id} failed: ${msg}`);
    await recordSyncRun(db, id, { ok: false, error: msg }).catch(() => undefined);
    return null;
  }
}

export async function startNotify(connection: ConnectionOptions, db: Db, cfg: NotifyConfig): Promise<() => Promise<void>> {
  const senders = makeSenders(cfg);
  const queue = new Queue(NOTIFY_QUEUE, { connection });
  const schedules = notifySchedules(cfg);
  const ids = new Set<string>(schedules.map((s) => s.id));
  for (const s of await queue.getJobSchedulers().catch(() => [])) {
    if (s.key && !ids.has(s.key)) await queue.removeJobScheduler(s.key).catch(() => false);
  }
  for (const s of schedules) {
    await queue.upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.id, data: {}, opts: { removeOnComplete: 20, removeOnFail: 20 } });
  }
  const worker = new Worker(NOTIFY_QUEUE, async (job: Job) => runNotifyTask(db, cfg, senders, job.name as TaskId), {
    connection,
    concurrency: 1,
    lockDuration: 5 * 60_000,
  });
  worker.on("error", (err) => console.warn("notify: worker error (non-fatal):", String(err).slice(0, 300)));
  console.log(
    `notify: ${schedules.map((s) => s.id).join(", ")} (telegram ${cfg.telegramToken ? "on" : "off"}, web push ${cfg.webpush ? "on" : "off"})`,
  );
  return async () => {
    await worker.close();
    await queue.close();
  };
}
