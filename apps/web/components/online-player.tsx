"use client";

/**
 * Онлайн-плеер балансеров (Kodik/Alloha) — быстрый старт без торрента.
 * Источники тянет клиент: ответ кэшируется на API, а страница тайтла
 * отдаётся из ISR и ждать балансер не должна.
 */
import type { OnlineSource } from "@zal/api-client";
import { Zap } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { buttonVariants } from "@/components/ui/button";
import { ChipButton } from "@/components/ui/chip";
import { useOptionalAuth } from "@/lib/auth";

/** null — ещё грузится; [] — ничего нет или балансеры выключены. */
export function useOnlineSources(itemId: number): OnlineSource[] | null {
  const api = useOptionalAuth()?.api ?? null;
  const [sources, setSources] = React.useState<OnlineSource[] | null>(null);
  React.useEffect(() => {
    if (!api) {
      setSources([]);
      return;
    }
    let cancelled = false;
    // Через then: синхронный сбой клиента — тоже «источников нет».
    Promise.resolve()
      .then(() => api.getOnlineSources(itemId))
      .then(
      (res) => {
        if (!cancelled) setSources(res.sources);
      },
      () => {
        if (!cancelled) setSources([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, itemId]);
  return sources;
}

/** Кнопка на странице тайтла: появляется, только если балансер что-то нашёл. */
export function OnlineButton({ itemId }: { itemId: number }) {
  const sources = useOnlineSources(itemId);
  if (!sources?.length) return null;
  return (
    <Link
      href={`/watch/${itemId}/online`}
      className={buttonVariants({ variant: "secondary" })}
      data-testid="online-button"
      title="Плеер со своего CDN — стартует сразу, без ожидания торрента"
    >
      <Zap className="mr-2 h-4 w-4" />
      Онлайн
    </Link>
  );
}

/** Подсказка в торрент-плеере: «долго грузится — есть онлайн». */
export function OnlineHint({ itemId }: { itemId: number }) {
  const sources = useOnlineSources(itemId);
  if (!sources?.length) return null;
  return (
    <Link
      href={`/watch/${itemId}/online`}
      className="inline-flex items-center gap-1 text-sm text-accent transition hover:text-white"
      data-testid="online-hint"
    >
      <Zap className="h-3.5 w-3.5" />
      Долго грузится? Смотреть в онлайн-плеере
    </Link>
  );
}

function sourceKey(s: OnlineSource) {
  return `${s.provider}:${s.url}`;
}

export function OnlinePlayer({ itemId, torrentHref }: { itemId: number; torrentHref: string | null }) {
  const sources = useOnlineSources(itemId);
  const [active, setActive] = React.useState<string | null>(null);
  const current = sources?.find((s) => sourceKey(s) === active) ?? sources?.[0] ?? null;

  if (sources === null) {
    return <div className="aspect-video w-full animate-pulse rounded-xl bg-surface" data-testid="online-loading" />;
  }
  if (!current) {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-xl bg-surface text-center" data-testid="online-empty">
        <p className="text-muted">В онлайн-плеерах этого тайтла пока нет.</p>
        {torrentHref && (
          <Link href={torrentHref} className={buttonVariants()}>
            Смотреть через торрент
          </Link>
        )}
      </div>
    );
  }
  return (
    <div data-testid="online-player">
      <div className="aspect-video w-full overflow-hidden rounded-xl bg-black">
        <iframe
          key={sourceKey(current)}
          src={current.url}
          title={current.label}
          className="h-full w-full"
          allow="autoplay *; fullscreen *; picture-in-picture *; encrypted-media *"
          allowFullScreen
          data-testid="online-iframe"
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {sources.length > 1 &&
          sources.map((s) => (
            <ChipButton
              key={sourceKey(s)}
              active={sourceKey(s) === sourceKey(current)}
              onClick={() => setActive(sourceKey(s))}
              data-testid="online-source"
            >
              {s.label}
              {s.quality ? <span className="ml-1 text-xs text-muted">{s.quality}</span> : null}
            </ChipButton>
          ))}
        {torrentHref && (
          <Link href={torrentHref} className="ml-auto text-sm text-muted transition hover:text-white">
            Смотреть через торрент
          </Link>
        )}
      </div>
    </div>
  );
}
