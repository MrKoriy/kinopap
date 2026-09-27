"use client";

import type { ItemSocialDto } from "@zal/api-client";
/**
 * Действия на карточке тайтла: голос за/против, подписка на новые серии,
 * счётчик комментариев. Оптимистичный UI — состояние меняется сразу,
 * при ошибке откатывается.
 */
import * as React from "react";
import { useOptionalAuth } from "@/lib/auth";

export function ItemActions({ itemId }: { itemId: number }) {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const user = auth?.user ?? null;

  const [social, setSocial] = React.useState<ItemSocialDto | null>(null);
  const [subscribed, setSubscribed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.getItemSocial(itemId).then(
      (res) => {
        if (cancelled) return;
        setSocial(res.social);
        setSubscribed(res.social.subscription != null);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, itemId]);

  /** Голос: клик по активному голосу снимает его. Оптимистично + откат. */
  const vote = React.useCallback(
    async (positive: boolean) => {
      if (!api || !social || busy) return;
      const prev = social;
      const prevVote = prev.vote.myVote;
      const nextVote = prevVote === positive ? null : positive;
      const dPos = (nextVote === true ? 1 : 0) - (prevVote === true ? 1 : 0);
      const dNeg = (nextVote === false ? 1 : 0) - (prevVote === false ? 1 : 0);

      setSocial({
        ...prev,
        vote: {
          ...prev.vote,
          myVote: nextVote,
          votes: {
            positive: prev.vote.votes.positive + dPos,
            negative: prev.vote.votes.negative + dNeg,
            total: prev.vote.votes.total + (nextVote === null ? -1 : prevVote === null ? 1 : 0),
          },
        },
      });

      try {
        const res =
          nextVote === null
            ? await api.clearVote(itemId)
            : await api.setVote(itemId, { positive: nextVote });
        setSocial((cur) => (cur ? { ...cur, vote: res.vote } : cur));
      } catch {
        setSocial(prev);
      }
    },
    [api, social, busy, itemId],
  );

  /** Подписка: переключается мгновенно, при ошибке возвращаем как было. */
  const toggleSubscription = React.useCallback(async () => {
    if (!api || busy) return;
    const was = subscribed;
    setSubscribed(!was);
    setBusy(true);
    try {
      if (was) await api.unsubscribe(itemId);
      else await api.subscribe(itemId, { notify: true });
    } catch {
      setSubscribed(was);
    } finally {
      setBusy(false);
    }
  }, [api, subscribed, busy, itemId]);

  if (!user || !api) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted">
        <a href="/login" className="text-accent hover:underline" data-testid="social-login-hint">
          Войдите
        </a>
        <span>чтобы голосовать, подписаться и комментировать</span>
      </div>
    );
  }

  const myVote = social?.vote.myVote ?? null;

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="item-actions">
      <div className="flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-1">
        <button
        type="button"
          className={`rounded-full px-2 py-0.5 text-sm transition ${
            myVote === true ? "bg-accent text-white" : "text-muted hover:text-white"
          }`}
          onClick={() => void vote(true)}
          data-testid="vote-up"
          aria-pressed={myVote === true}
        >
          ▲
        </button>
        <span className="min-w-6 text-center text-sm text-white" data-testid="vote-positive">
          {social?.vote.votes.positive ?? 0}
        </span>
        <button
        type="button"
          className={`rounded-full px-2 py-0.5 text-sm transition ${
            myVote === false ? "bg-red-500 text-white" : "text-muted hover:text-white"
          }`}
          onClick={() => void vote(false)}
          data-testid="vote-down"
          aria-pressed={myVote === false}
        >
          ▼
        </button>
        <span className="min-w-6 text-center text-sm text-white" data-testid="vote-negative">
          {social?.vote.votes.negative ?? 0}
        </span>
      </div>

      <button
        type="button"
        className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
          subscribed
            ? "border border-accent text-accent hover:border-red-400 hover:text-red-400"
            : "bg-accent text-white hover:bg-accent-hover"
        }`}
        onClick={() => void toggleSubscription()}
        data-testid="subscribe-button"
        aria-pressed={subscribed}
      >
        {subscribed ? "Вы подписаны ✓" : "Подписаться на новые серии"}
      </button>

      <span className="text-sm text-muted">
        <span data-testid="comments-count">{social?.commentsCount ?? 0}</span> комментариев
      </span>
    </div>
  );
}
