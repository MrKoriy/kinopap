/**
 * Уведомления о новых сериях, рекомендации и сводка Ops.
 */
import { z } from "zod";
import { itemSummarySchema } from "./catalog";

export const notifyConfigSchema = z.object({
  /** Имя бота без @ или null — Telegram не настроен. */
  telegramBot: z.string().nullable(),
  /** Публичный VAPID-ключ или null — web push не настроен. */
  webpushKey: z.string().nullable(),
});
export type NotifyConfig = z.infer<typeof notifyConfigSchema>;

export const notifyChannelSchema = z.object({
  id: z.number().int(),
  kind: z.enum(["telegram", "webpush"]),
  label: z.string().nullable(),
  createdAt: z.string(),
});
export type NotifyChannel = z.infer<typeof notifyChannelSchema>;

export const notifyChannelsResponseSchema = z.object({ channels: z.array(notifyChannelSchema) });
export const notifyChannelResponseSchema = z.object({ channel: notifyChannelSchema });
export const telegramLinkResponseSchema = z.object({ url: z.string(), code: z.string() });

export const webPushSubscriptionSchema = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  label: z.string().optional(),
});
export type WebPushSubscriptionInput = z.infer<typeof webPushSubscriptionSchema>;

export const recommendationsResponseSchema = z.object({ items: z.array(itemSummarySchema) });

const percentiles = z.object({
  name: z.string(),
  count: z.number(),
  p50: z.number().nullable(),
  p75: z.number().nullable(),
  p95: z.number().nullable(),
  goodShare: z.number().nullable().optional(),
});

export const errorEventSchema = z.object({
  id: z.number(),
  source: z.string(),
  message: z.string(),
  stack: z.string().nullable(),
  page: z.string().nullable(),
  release: z.string().nullable(),
  count: z.number(),
  firstSeen: z.string(),
  lastSeen: z.string(),
});
export type ErrorEvent = z.infer<typeof errorEventSchema>;

export const opsSummarySchema = z.object({
  rum: z
    .object({
      hours: z.number(),
      metrics: z.array(percentiles.loose()),
      ttff: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .loose(),
  sync: z.array(
    z
      .object({
        key: z.string(),
        lastRunAt: z.string().nullable(),
        lastOkAt: z.string().nullable(),
        stats: z.record(z.string(), z.unknown()).nullable(),
        error: z.string().nullable(),
      })
      .loose(),
  ),
  errors: z.array(errorEventSchema).default([]),
});
export type OpsSummary = z.infer<typeof opsSummarySchema>;
