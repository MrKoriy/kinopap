"use client";

import type { NotifyChannel, NotifyConfig } from "@zal/api-client";
import { Bell, Send, Trash2 } from "lucide-react";
/**
 * Куда слать новые серии подписок: Telegram-бот и/или push в браузере.
 * Telegram: ссылка t.me/<bot>?start=<code> → «Start» в боте → воркер
 * привязывает чат; пока ждём, раз в 3 с перечитываем список каналов.
 */
import * as React from "react";
import { buttonVariants } from "@/components/ui/button";
import { useOptionalAuth } from "@/lib/auth";
import { pushSupported, subscribePush } from "@/lib/push";

const POLL_MS = 3000;
const POLL_FOR_MS = 3 * 60_000;

export function NotifySettings() {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const isAuthed = auth?.isAuthed ?? false;
  const [config, setConfig] = React.useState<NotifyConfig | null>(null);
  const [channels, setChannels] = React.useState<NotifyChannel[]>([]);
  const [waitingTg, setWaitingTg] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!api) return;
    const res = await api.listNotifyChannels().catch(() => null);
    if (res) setChannels(res.channels);
  }, [api]);

  React.useEffect(() => {
    if (!api || !isAuthed) return;
    void api.getNotifyConfig().then(setConfig, () => setConfig({ telegramBot: null, webpushKey: null }));
    void reload();
  }, [api, isAuthed, reload]);

  // Ждём привязку Telegram: опрос, пока не появится новый telegram-канал.
  const tgCount = channels.filter((c) => c.kind === "telegram").length;
  const tgBefore = React.useRef(0);
  React.useEffect(() => {
    if (!waitingTg) return;
    if (tgCount > tgBefore.current) {
      setWaitingTg(false);
      setStatus("Telegram подключён");
      return;
    }
    const started = Date.now();
    const t = window.setInterval(() => {
      if (Date.now() - started > POLL_FOR_MS) setWaitingTg(false);
      else void reload();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [waitingTg, tgCount, reload]);

  if (!isAuthed || !config) return null;
  const nothing = !config.telegramBot && !config.webpushKey;

  const linkTelegram = async () => {
    if (!api) return;
    setBusy(true);
    setStatus(null);
    // Окно открываем синхронно с кликом — иначе блокировщик попапов.
    const win = window.open("about:blank", "_blank");
    try {
      const { url } = await api.linkTelegram();
      tgBefore.current = tgCount;
      if (win) win.location.href = url;
      else window.location.href = url;
      setWaitingTg(true);
    } catch {
      win?.close();
      setStatus("Не удалось получить ссылку на бота");
    } finally {
      setBusy(false);
    }
  };

  const enablePush = async () => {
    if (!api || !config.webpushKey) return;
    setBusy(true);
    setStatus(null);
    const res = await subscribePush(config.webpushKey);
    if (!res.ok) {
      setStatus(
        res.reason === "denied"
          ? "Браузер запретил уведомления — разрешите их в настройках сайта"
          : res.reason === "unsupported"
            ? "Этот браузер не поддерживает push-уведомления"
            : "Не удалось подписаться на уведомления",
      );
    } else {
      await api.addWebPush(res.subscription).then(
        () => setStatus("Уведомления в этом браузере включены"),
        () => setStatus("Не удалось сохранить подписку"),
      );
      await reload();
    }
    setBusy(false);
  };

  const remove = async (id: number) => {
    if (!api) return;
    setChannels((cur) => cur.filter((c) => c.id !== id));
    await api.deleteNotifyChannel(id).catch(() => reload());
  };

  return (
    <section className="mb-10 rounded-[var(--radius-card)] border border-border bg-surface p-5" data-testid="notify-settings">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold text-white">
        <Bell className="h-5 w-5" /> Уведомления о новых сериях
      </h2>
      <p className="mb-4 text-sm text-muted">
        {nothing
          ? "Уведомления пока не настроены на сервере."
          : "Пришлём, когда у сериалов из подписок выйдет новая серия."}
      </p>
      <div className="flex flex-wrap gap-3">
        {config.telegramBot && (
          <button type="button" className={buttonVariants()} disabled={busy} onClick={linkTelegram} data-testid="notify-telegram">
            <Send className="mr-2 h-4 w-4" />
            {waitingTg ? "Ждём подтверждения в Telegram…" : tgCount > 0 ? "Подключить ещё Telegram" : "Подключить Telegram"}
          </button>
        )}
        {config.webpushKey && pushSupported() && (
          <button
            type="button"
            className={buttonVariants({ variant: "secondary" })}
            disabled={busy}
            onClick={enablePush}
            data-testid="notify-push"
          >
            <Bell className="mr-2 h-4 w-4" />
            Push в этом браузере
          </button>
        )}
      </div>
      {status && (
        <p className="mt-3 text-sm text-muted" role="status">
          {status}
        </p>
      )}
      {channels.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border" data-testid="notify-channels">
          {channels.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="text-white">{c.kind === "telegram" ? "Telegram" : "Push"}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{c.label}</span>
              <button
                type="button"
                className="text-muted transition hover:text-white"
                aria-label="Отключить канал"
                onClick={() => void remove(c.id)}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
