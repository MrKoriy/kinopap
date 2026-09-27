"use client";

/**
 * Действия на карточке тайтла: голос за/против и подписка на новые серии.
 * Оптимистичный UI — состояние меняется сразу, при ошибке откатывается.
 */
import * as React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ItemSocialDto } from "@zal/api-client";
import { tokens } from "@zal/ui";
import { useAuth } from "../lib/auth";

export function ItemActions({ itemId }: { itemId: number }) {
  const { user, api } = useAuth();
  const [social, setSocial] = React.useState<ItemSocialDto | null>(null);
  const [subscribed, setSubscribed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
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
  }, [api, itemId, user]);

  /** Голос: клик по активному голосу снимает его. */
  const vote = React.useCallback(
    async (positive: boolean) => {
      if (!social || busy) return;
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
    if (busy) return;
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

  if (!user) {
    return (
      <View style={styles.guestRow} testID="social-login-hint">
        <Text style={styles.guestText}>
          Войдите, чтобы голосовать, подписаться и комментировать
        </Text>
      </View>
    );
  }

  const myVote = social?.vote.myVote ?? null;

  return (
    <View style={styles.row} testID="item-actions">
      <View style={styles.voteBox}>
        <Pressable
          testID="vote-up"
          onPress={() => void vote(true)}
          style={[styles.voteButton, myVote === true && styles.voteActive]}
          accessibilityRole="button"
          accessibilityLabel="Голос за"
        >
          <Text style={styles.voteGlyph}>▲</Text>
        </Pressable>
        <Text style={styles.voteCount} testID="vote-positive">
          {social?.vote.votes.positive ?? 0}
        </Text>
        <Pressable
          testID="vote-down"
          onPress={() => void vote(false)}
          style={[styles.voteButton, myVote === false && styles.voteActiveDown]}
          accessibilityRole="button"
          accessibilityLabel="Голос против"
        >
          <Text style={styles.voteGlyph}>▼</Text>
        </Pressable>
        <Text style={styles.voteCount} testID="vote-negative">
          {social?.vote.votes.negative ?? 0}
        </Text>
      </View>

      <Pressable
        testID="subscribe-button"
        onPress={() => void toggleSubscription()}
        style={[styles.subButton, subscribed && styles.subButtonActive]}
        accessibilityRole="button"
      >
        <Text style={styles.subText}>
          {subscribed ? "Вы подписаны ✓" : "Подписаться на новые серии"}
        </Text>
      </Pressable>

      <Text style={styles.comments} testID="comments-count">
        {social?.commentsCount ?? 0} комм.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: tokens.space.sm,
  },
  guestRow: {
    paddingVertical: tokens.space.sm,
  },
  guestText: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
  },
  voteBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.xs,
    borderRadius: tokens.radius.full,
    borderWidth: 1,
    borderColor: tokens.color.border,
    backgroundColor: tokens.color.surface,
    paddingHorizontal: tokens.space.sm,
    paddingVertical: tokens.space.xs,
  },
  voteButton: {
    paddingHorizontal: tokens.space.xs,
    paddingVertical: 2,
    borderRadius: tokens.radius.full,
  },
  voteActive: {
    backgroundColor: tokens.color.accent,
  },
  voteActiveDown: {
    backgroundColor: "#b3261e",
  },
  voteGlyph: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
  },
  voteCount: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    minWidth: 18,
    textAlign: "center",
  },
  subButton: {
    borderRadius: tokens.radius.full,
    backgroundColor: tokens.color.accent,
    paddingHorizontal: tokens.space.md,
    paddingVertical: tokens.space.sm,
  },
  subButtonActive: {
    backgroundColor: tokens.color.surface,
    borderWidth: 1,
    borderColor: tokens.color.accent,
  },
  subText: {
    color: tokens.color.text,
    fontSize: tokens.fontSize.sm,
    fontWeight: "600",
  },
  comments: {
    color: tokens.color.textMuted,
    fontSize: tokens.fontSize.sm,
  },
});
