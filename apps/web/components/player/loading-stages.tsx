"use client";

/**
 * Этапы старта видео вместо пустого спиннера: «ищем источник →
 * подключаемся → буферизуем». Пользователь видит, где именно ждём, и
 * пауза не читается как зависание. Только показ — какой этап сейчас,
 * решают watch-client (поиск источника) и player (подключение/буфер).
 */
import { Check } from "lucide-react";

export type StartStage = "search" | "connect" | "buffer";

export const START_STAGES: ReadonlyArray<{ id: StartStage; label: string }> = [
  { id: "search", label: "Ищем источник" },
  { id: "connect", label: "Подключаемся" },
  { id: "buffer", label: "Буферизуем" },
];

export function LoadingStages({
  stage,
  hint,
  overlay = false,
}: {
  stage: StartStage;
  /** Подпись под шагами: сколько ждём, какую раздачу пробуем. */
  hint?: string | null;
  /** Поверх видео (полупрозрачно, без перехвата кликов). */
  overlay?: boolean;
}) {
  const current = START_STAGES.findIndex((s) => s.id === stage);
  return (
    <div
      className={
        overlay
          ? "pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/50 text-white"
          : "flex flex-col items-center gap-3 text-white"
      }
      data-testid="player-stages"
      data-stage={stage}
      role="status"
      aria-live="polite"
    >
      <ol className="flex items-center gap-2 text-xs sm:text-sm">
        {START_STAGES.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={s.id} className="flex items-center gap-2">
              {i > 0 && (
                <span
                  aria-hidden
                  className={`h-px w-4 sm:w-8 ${done || active ? "bg-white/60" : "bg-white/15"}`}
                />
              )}
              <span
                className={`flex items-center gap-1.5 ${
                  active ? "font-semibold text-white" : done ? "text-white/70" : "text-white/35"
                }`}
                data-testid={`stage-${s.id}`}
                data-state={done ? "done" : active ? "active" : "pending"}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                ) : active ? (
                  <span
                    aria-hidden
                    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/25 border-t-white"
                  />
                ) : (
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white/30" />
                )}
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
      {hint && <p className="max-w-sm px-4 text-center text-xs text-white/55">{hint}</p>}
    </div>
  );
}
