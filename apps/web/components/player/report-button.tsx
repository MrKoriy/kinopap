"use client";

/**
 * «Не играет / не та серия»: жалоба на текущую раздачу. Сервер помечает
 * её bad для этой серии, и следующий запрос ссылок отдаёт другую —
 * watch-страница сразу перезапрашивает источники (onReported).
 */
import { ApiError, type StreamReportReason, streamHashFromUrl } from "@zal/api-client";
import { Flag } from "lucide-react";
import * as React from "react";
import { useAuth } from "@/lib/auth";

export function StreamReportButton({
  mediaId,
  streamUrl,
  isEpisode,
  onReported,
}: {
  mediaId: number;
  /** URL играющей раздачи: по нему сервер узнаёт, что банить. */
  streamUrl: string | null | undefined;
  /** Серия сериала — тогда есть пункт «Не та серия». */
  isEpisode: boolean;
  onReported?: () => void;
}) {
  const { api } = useAuth();
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<"idle" | "sending" | "done" | "error" | "limited">("idle");
  const hash = streamHashFromUrl(streamUrl);

  // Жаловаться можно только на торрент-раздачу: у HLS-источников (AniLibria,
  // свои файлы) заменять нечем — кнопка лишь обещала бы зря.
  if (!hash) return null;

  const send = async (reason: StreamReportReason) => {
    setState("sending");
    try {
      await api.reportStream(mediaId, { reason, hash });
      setState("done");
      setOpen(false);
      onReported?.();
    } catch (err) {
      setState(err instanceof ApiError && err.status === 429 ? "limited" : "error");
    }
  };

  return (
    <div className="absolute left-4 top-4 z-30" data-testid="stream-report">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white/85 backdrop-blur transition hover:bg-black/80 hover:text-white"
        data-testid="stream-report-toggle"
      >
        <Flag className="h-3.5 w-3.5" aria-hidden />
        {isEpisode ? "Не играет / не та серия" : "Не играет"}
      </button>
      {open && (
        <div className="mt-2 w-60 overflow-hidden rounded-xl border border-white/10 bg-surface/95 p-1 text-sm shadow-xl backdrop-blur">
          <button
            type="button"
            disabled={state === "sending"}
            onClick={() => void send("not_playing")}
            className="block w-full rounded-lg px-3 py-2 text-left text-white/90 hover:bg-white/10 disabled:opacity-50"
            data-testid="stream-report-not-playing"
          >
            Не играет — найти другую раздачу
          </button>
          {isEpisode && (
            <button
              type="button"
              disabled={state === "sending"}
              onClick={() => void send("wrong_episode")}
              className="block w-full rounded-lg px-3 py-2 text-left text-white/90 hover:bg-white/10 disabled:opacity-50"
              data-testid="stream-report-wrong-episode"
            >
              Не та серия
            </button>
          )}
          {(state === "error" || state === "limited") && (
            <p className="px-3 pb-2 pt-1 text-xs text-red-300" role="alert">
              {state === "limited"
                ? "Слишком много жалоб подряд — попробуйте через минуту"
                : "Не удалось отправить, попробуйте ещё раз"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
