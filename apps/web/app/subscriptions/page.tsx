"use client";

import type { NewEpisodeDto, SubscriptionDto } from "@zal/api-client";
import Link from "next/link";
/**
 * Мои подписки: лента новых серий (что вышло и не досмотрено)
 * и список подписанных тайтлов с отпиской.
 */
import * as React from "react";
import { useOptionalAuth } from "@/lib/auth";
import { formatDate, formatDuration } from "@/lib/format";

export default function SubscriptionsPage() {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const user = auth?.user ?? null;

  const [subs, setSubs] = React.useState<SubscriptionDto[]>([]);
  const [episodes, setEpisodes] = React.useState<NewEpisodeDto[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!api || !user) return;
    let cancelled = false;
    void Promise.all([api.listSubscriptions(), api.getNewEpisodes()]).then(
      ([s, e]) => {
        if (cancelled) return;
        setSubs(s.items);
        setEpisodes(e.items);
        setLoaded(true);
      },
      () => {
        if (!cancelled) setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, user]);

  if (!user) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-16 text-center">
        <p className="text-muted" data-testid="subs-login-hint">
          <Link href="/login" className="text-accent hover:underline">
            Войдите
          </Link>
          , чтобы видеть подписки и новые серии.
        </p>
      </main>
    );
  }

  const unsubscribe = async (itemId: number) => {
    if (!api) return;
    const prev = subs;
    setSubs((cur) => cur.filter((s) => s.itemId !== itemId));
    try {
      await api.unsubscribe(itemId);
    } catch {
      setSubs(prev);
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-8 text-2xl font-bold text-white">Мои подписки</h1>

      <section className="mb-10" data-testid="subs-feed">
        <h2 className="mb-4 text-xl font-semibold text-white">Новые серии</h2>
        {loaded && episodes.length === 0 && (
          <p className="text-sm text-muted" data-testid="feed-empty">
            Нового нет — всё просмотрено или подписок пока нет.
          </p>
        )}
        <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
          {episodes.map((ep) => (
            <li key={ep.mediaId}>
              <Link
                href={`/watch/${ep.itemId}/${ep.mediaId}`}
                className="flex items-center gap-4 px-4 py-3 transition hover:bg-surface-2"
                data-testid="new-episode-row"
              >
                <span className="text-sm font-semibold text-accent">
                  {ep.kind === "episode"
                    ? `S${ep.seasonNumber}E${ep.episodeNumber}`
                    : `Часть ${ep.partNumber}`}
                </span>
                <span className="flex-1">
                  <span className="block text-sm text-white">
                    {ep.itemTitle}
                    {ep.kind === "episode" && ep.episodeTitle
                      ? ` — ${ep.episodeTitle}`
                      : ep.title
                        ? ` — ${ep.title}`
                        : ""}
                  </span>
                  <span className="text-xs text-muted">{formatDate(ep.publishedAt)}</span>
                </span>
                {ep.runtime > 0 && (
                  <span className="text-xs text-muted">{formatDuration(ep.runtime)}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section data-testid="subs-list">
        <h2 className="mb-4 text-xl font-semibold text-white">Тайтлы</h2>
        {loaded && subs.length === 0 && (
          <p className="text-sm text-muted" data-testid="subs-empty">
            Подписок нет. Подпишитесь на тайтл, чтобы не пропустить новые серии.
          </p>
        )}
        <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
          {subs.map((s) => (
            <li key={s.itemId} className="flex items-center gap-4 px-4 py-3" data-testid="subs-item">
              <Link href={`/item/${s.itemId}`} className="flex-1 text-sm text-white hover:text-accent">
                {s.item.title}
                {s.item.year ? <span className="text-muted"> ({s.item.year})</span> : null}
              </Link>
              <button
        type="button"
                className="text-sm text-muted transition hover:text-red-400"
                onClick={() => void unsubscribe(s.itemId)}
                data-testid="unsub-button"
              >
                Отписаться
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
