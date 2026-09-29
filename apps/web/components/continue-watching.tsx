"use client";

import type { ItemSummary, ProgressDto } from "@zal/api-client";
import { Film, Play } from "lucide-react";
import Link from "next/link";
/**
 * Лента «Продолжить смотреть»: последние незавершённые тайтлы профиля.
 * Клиентский компонент — прогресс персонален и не кэшируется на SSR.
 */
import * as React from "react";
import { PosterImage } from "@/components/poster-image";
import { useAuth } from "@/lib/auth";

interface ContinueEntry {
  progress: ProgressDto;
  item: ItemSummary;
}

const MAX_ENTRIES = 8;

function formatLeft(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `осталось ${m} мин`;
  return `осталось ${Math.floor(m / 60)} ч ${m % 60} мин`;
}

/** Отбор записей ленты: незавершённые, свежие первыми, без дублей по
 * тайтлу (несколько media одного item — оставляем самую свежую позицию). */
export function selectContinueProgress(progressRows: ProgressDto[]): ProgressDto[] {
  const watching = progressRows
    .filter(
      (p) =>
        p.durationSeconds > 0 &&
        p.positionSeconds / p.durationSeconds >= 0.02 &&
        p.positionSeconds / p.durationSeconds < 0.95,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_ENTRIES);
  const seen = new Set<number>();
  return watching.filter((p) => {
    if (seen.has(p.itemId)) return false;
    seen.add(p.itemId);
    return true;
  });
}

/** Матч отобранного прогресса с карточками батча по id: тайтл без карточки
 * (удалён из каталога) молча выпадает — как раньше при ошибке getItem. */
export function matchContinueItems(
  progress: ProgressDto[],
  items: ItemSummary[],
): ContinueEntry[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  return progress.flatMap((p) => {
    const item = byId.get(p.itemId);
    return item ? [{ progress: p, item }] : [];
  });
}

function Card({ entry }: { entry: ContinueEntry }) {
  const { item, progress } = entry;
  const ratio =
    progress.durationSeconds > 0
      ? Math.min(1, progress.positionSeconds / progress.durationSeconds)
      : 0;
  const poster = item.posters.medium ?? item.posters.small ?? item.posters.big;

  return (
    <Link
      href={`/watch/${item.id}/${progress.mediaId}`}
      className="group relative block w-40 shrink-0 overflow-hidden rounded-[var(--radius-card)] sm:w-48"
      data-testid="continue-card"
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface-2">
        {poster ? (
          <PosterImage
            src={poster}
            alt={item.title}
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            sizes="(max-width: 640px) 50vw, 16vw"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-4 text-center">
            <Film className="mb-2 h-8 w-8 text-white/30" />
            <span className="line-clamp-2 text-sm font-semibold text-white/90">
              {item.title}
            </span>
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent">
            <Play className="ml-0.5 h-5 w-5 fill-white text-white" />
          </span>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 to-transparent px-3 pb-3 pt-8">
        <p className="truncate text-sm font-semibold text-white">{item.title}</p>
        <p className="mt-0.5 text-xs text-white/60">{formatLeft(progress.durationSeconds - progress.positionSeconds)}</p>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/20">
          <div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>
    </Link>
  );
}

export function ContinueWatching() {
  const { api, isAuthed } = useAuth();
  const [entries, setEntries] = React.useState<ContinueEntry[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!isAuthed) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { items: progressRows } = await api.listProgress();
        const unique = selectContinueProgress(progressRows);
        // Один батч-запрос вместо getItem на каждую запись (было до 8 RT).
        const { items } = await api.getItemsSummary(unique.map((p) => p.itemId));
        if (cancelled) return;
        setEntries(matchContinueItems(unique, items));
      } catch {
        // Прогресс недоступен — лента просто не показывается.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, isAuthed]);

  if (!loaded || entries.length === 0) return null;

  return (
    <section className="mb-10" data-testid="continue-rail">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-xl font-semibold text-white">Продолжить смотреть</h2>
        <Link
          href="/profile"
          className="text-sm text-muted transition hover:text-white"
          data-testid="continue-all-history"
        >
          Вся история →
        </Link>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((e) => (
          <Card key={`${e.progress.itemId}-${e.progress.mediaId}`} entry={e} />
        ))}
      </div>
    </section>
  );
}
