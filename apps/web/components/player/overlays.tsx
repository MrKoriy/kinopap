"use client";

import type { SubtitleCue } from "@zal/shared";
import { Volume2 } from "lucide-react";
import * as React from "react";
import type { PlayerEpisode } from "@/lib/player-logic";

/**
 * Слои поверх видео: субтитры, интро, «включить звук», следующая серия,
 * буферизация и экран ошибки.
 *
 * Здесь только показ: ни один компонент не знает ни про hls.js, ни про
 * состояние раздачи. Всё, что решает, что рисовать, остаётся в `player.tsx` —
 * иначе оверлей и логика разъехались бы, как это уже было с «Следующей серией»
 * и меню выбора серии, которые считали серию каждая по-своему.
 */

/** Реплики субтитров, уже отобранные по времени и сдвигу. */
export function SubtitleOverlay({ cues }: { cues: readonly SubtitleCue[] }) {
  if (cues.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-24 flex flex-col items-center gap-1 px-8 text-center"
      data-testid="subtitle-overlay"
    >
      {cues.map((c, i) => (
        <span
          key={`${c.start}-${i}`}
          className="rounded bg-black/70 px-2 py-1 text-lg font-medium text-white"
        >
          {c.text}
        </span>
      ))}
    </div>
  );
}

/** «Пропустить интро» — пока идёт размеченный отрезок. */
export function SkipIntroButton({
  endSeconds,
  onSkip,
}: {
  endSeconds: number;
  onSkip: (seconds: number) => void;
}) {
  return (
    <button
      type="button"
      className="absolute bottom-28 right-6 rounded-full bg-white/90 px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-white"
      onClick={() => onSkip(endSeconds)}
      data-testid="skip-intro"
    >
      Пропустить интро
    </button>
  );
}

/**
 * Автоплей без звука: политика браузера не дала играть со звуком — даём явную
 * кнопку, чтобы не оставить пользователя в тишине без выхода.
 */
export function UnmuteOverlay({ onUnmute }: { onUnmute: () => void }) {
  return (
    <button
      type="button"
      onClick={onUnmute}
      className="absolute right-4 top-4 inline-flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-sm font-semibold text-black transition hover:bg-white"
      data-testid="unmute-overlay"
    >
      <Volume2 className="h-4 w-4" />
      Включить звук
    </button>
  );
}

/** Предложение перейти к следующей серии на последних секундах. */
export function NextEpisodeOverlay({
  next,
  onPlay,
}: {
  next: PlayerEpisode;
  onPlay: () => void;
}) {
  return (
    <div
      className="absolute bottom-28 left-6 rounded-[var(--radius-card)] border border-border bg-black/80 p-4"
      data-testid="next-episode"
    >
      <p className="mb-2 text-sm text-muted">Следующая серия</p>
      <button
        type="button"
        className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
        onClick={onPlay}
      >
        {next.label}
      </button>
    </div>
  );
}

/**
 * Индикатор буферизации. Отдельный текст на переборе раздач: пауза без
 * объяснения читается как зависание, а тут видно, что плеер работает и
 * которую раздачу пробует.
 */
export function BufferingOverlay({
  switchingSource,
  deadCount,
  totalFiles,
}: {
  switchingSource: boolean;
  deadCount: number;
  totalFiles: number;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/40 text-white"
      data-testid="player-buffering"
    >
      <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
      <p className="text-sm font-medium text-white/90">
        {switchingSource
          ? `Раздача не заиграла — пробуем следующую (${deadCount + 1} из ${totalFiles})…`
          : "Буферизация потока / поиск пиров в сети..."}
      </p>
    </div>
  );
}

/**
 * Экран ошибки. Внешние плееры и копирование ссылки — здесь, а не в
 * `PlayerControls`: в контрол-баре их нет и быть не должно, они нужны ровно
 * тогда, когда браузер не справился.
 *
 * `copied` живёт в этом компоненте: состояние кнопки не нужно никому снаружи,
 * а в родителе оно переживало размонтирование и оставляло висящий таймер.
 */
export function PlaybackError({
  error,
  streamUrl,
  onRetry,
}: {
  error: string;
  /** Абсолютный адрес потока; пустая строка — внешним плеерам нечего дать. */
  streamUrl: string;
  onRetry: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const copyTimer = React.useRef(0);

  React.useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copy = React.useCallback(() => {
    void navigator.clipboard.writeText(streamUrl);
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
  }, [streamUrl]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/90 p-6 text-center text-white">
      <div className="max-w-md">
        <h3 className="mb-2 text-base font-semibold text-white">
          Не удалось воспроизвести в браузере
        </h3>
        <p className="mb-5 text-sm text-muted">{error}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover"
            data-testid="player-retry"
          >
            Попробовать снова
          </button>
          {streamUrl && (
            <>
              <a
                href={`iina://weblink?url=${encodeURIComponent(streamUrl)}`}
                className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover"
              >
                Открыть в IINA (Mac)
              </a>
              <a
                href={`vlc://${streamUrl}`}
                className="rounded-full border border-border bg-surface-elevated px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Открыть в VLC
              </a>
              <button
                type="button"
                onClick={copy}
                className="rounded-full border border-border bg-surface px-4 py-2 text-sm text-white/80 transition hover:bg-white/10"
              >
                {copied ? "Ссылка скопирована" : "Скопировать поток"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
