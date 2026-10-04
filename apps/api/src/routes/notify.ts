/**
 * Уведомления о новых сериях по подпискам: каналы пользователя.
 *
 * Telegram: POST /notify/telegram/link → ссылка t.me/<bot>?start=<code>;
 * воркер ловит /start <code> в getUpdates и привязывает чат. Web push:
 * браузер подписывается VAPID-ключом из /notify/config и отдаёт подписку
 * сюда. Рассылку делает воркер (src/notify.ts).
 */
import {
  addWebPushChannel,
  createTelegramLinkCode,
  type Db,
  deleteNotifyChannel,
  listNotifyChannels,
} from "@zal/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config";
import { HttpError, parseOrThrow } from "../lib/http";

const webPushSchema = z.object({
  endpoint: z.url().max(1000).refine((u) => u.startsWith("https://"), "https only"),
  keys: z.object({ p256dh: z.string().min(16).max(200), auth: z.string().min(8).max(100) }),
  label: z.string().max(120).optional(),
});

const idParams = z.object({ id: z.coerce.number().int().positive() });

export async function notifyRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;

  app.get("/notify/config", async () => ({
    telegramBot: config.telegramBotToken && config.telegramBotName ? config.telegramBotName : null,
    webpushKey: config.webpushPublicKey ?? null,
  }));

  app.get("/notify/channels", { preHandler: app.authenticate }, async (request) => ({
    channels: await listNotifyChannels(db, request.user.sub),
  }));

  app.post(
    "/notify/telegram/link",
    { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      if (!config.telegramBotToken || !config.telegramBotName) {
        throw new HttpError(503, "telegram_disabled", "Telegram-бот не настроен");
      }
      const code = await createTelegramLinkCode(db, request.user.sub);
      return { url: `https://t.me/${config.telegramBotName}?start=${code}`, code };
    },
  );

  app.post(
    "/notify/webpush",
    { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      if (!config.webpushPublicKey) throw new HttpError(503, "webpush_disabled", "Web push не настроен");
      const body = parseOrThrow(webPushSchema, request.body ?? {});
      const ua = String(request.headers["user-agent"] ?? "");
      const label = body.label ?? (/(Firefox|Edg|OPR|YaBrowser|Chrome|Safari)\/[\d.]+/.exec(ua)?.[1] ?? "Браузер");
      return { channel: await addWebPushChannel(db, request.user.sub, body, label) };
    },
  );

  app.delete("/notify/channels/:id", { preHandler: app.authenticate }, async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    const ok = await deleteNotifyChannel(db, request.user.sub, id);
    if (!ok) throw new HttpError(404, "not_found", "Канал не найден");
    return { ok: true };
  });
}
