"use client";

import type { ItemDetail } from "@zal/api-client";
import { Film, Play, X } from "lucide-react";
import Link from "next/link";
/**
 * Страница тайтла: инфо, рейтинги, кнопка «Смотреть», сезоны и эпизоды.
 */
import * as React from "react";
import { Comments } from "@/components/comments";
import { ItemActions } from "@/components/item-actions";
import { PosterImage } from "@/components/poster-image";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { formatDuration } from "@/lib/format";

export function ItemDetailView({ item }: { item: ItemDetail }) {
  const [activeSeason, setActiveSeason] = React.useState(0);
  const [showTrailer, setShowTrailer] = React.useState(false);
  const { api, isAuthed } = useAuth();

  const firstMovieMedia = item.media?.[0]?.id ?? null;
  const firstEpisodeMedia = item.seasons?.[0]?.episodes.find((e) => e.mediaId)?.mediaId ?? null;
  const playMediaId = firstMovieMedia ?? firstEpisodeMedia ?? item.id;

  // Тихий прогрев стримов, пока пользователь читает карточку: резолвер
  // положит релиз в TorrServer и кэш API — переход «Смотреть» откроется
  // мгновенно, пиры к моменту play уже подключены.
  React.useEffect(() => {
    if (!isAuthed) return;
    void api.getMediaLinks(item.id, playMediaId).catch(() => {});
  }, [api, isAuthed, item.id, playMediaId]);

  const poster = item.posters.big ?? item.posters.medium;
  const rating = item.rating > 0 ? item.rating : item.imdb.rating;

  const trailerEmbedUrl = item.trailer?.url
    ? item.trailer.url.replace("watch?v=", "embed/")
    : `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(`${item.title} трейлер русский`)}&autoplay=1`;

  return (
    <div>
      {/* Шапка */}
      <div className="relative mb-8 min-h-[380px] overflow-hidden rounded-[var(--radius-card)] bg-surface-2">
        <div className="relative h-[380px] w-full">
          <PosterImage
            src={poster}
            alt={item.title}
            className="h-full w-full object-cover object-top"
            sizes="100vw"
            priority
          />
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent" />
        <div className="absolute bottom-6 left-6 right-6">
          <h1 className="text-3xl font-bold text-white sm:text-4xl" data-testid="item-title">
            {item.title}
          </h1>
          {item.originalTitle && (
            <p className="mt-1 text-sm text-white/60">{item.originalTitle}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {rating !== null && rating > 0 && (
              <Badge className="bg-accent text-white">★ {rating.toFixed(1)}</Badge>
            )}
            {item.year && <Badge className="bg-white/10 text-white">{item.year}</Badge>}
            {item.genres.map((g) => (
              <Badge key={g.id} className="bg-white/10 text-white">
                {g.title}
              </Badge>
            ))}
            {item.duration.average ? (
              <Badge className="bg-white/10 text-white">
                {formatDuration(item.duration.average)}
              </Badge>
            ) : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href={`/watch/${item.id}/${playMediaId}`}
              className={buttonVariants()}
              data-testid="watch-button"
            >
              <Play className="mr-2 h-4 w-4 fill-current" />
              Смотреть
            </Link>

            <button
              type="button"
              onClick={() => setShowTrailer(true)}
              className="inline-flex items-center rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
              data-testid="trailer-button"
            >
              <Film className="mr-2 h-4 w-4" />
              Трейлер
            </button>

            <div className="self-center">
              <ItemActions itemId={item.id} />
            </div>
          </div>
        </div>
      </div>

      {/* Модальное окно предпросмотра трейлера */}
      {showTrailer && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
        >
          <div className="relative w-full max-w-4xl overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <Film className="h-4 w-4 text-accent" />
                <span>Трейлер: {item.title}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowTrailer(false)}
                className="rounded-lg p-1 text-white/70 hover:bg-white/10 hover:text-white"
                aria-label="Закрыть трейлер"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="aspect-video w-full bg-black">
              <iframe
                src={trailerEmbedUrl}
                title={`Трейлер ${item.title}`}
                className="h-full w-full border-0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            </div>
          </div>
        </div>
      )}

      {/* Описание */}
      {item.plot && (
        <p className="mb-8 max-w-3xl leading-relaxed text-muted" data-testid="item-plot">
          {item.plot}
        </p>
      )}

      {/* Создатели */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        {item.director.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold text-white">Режиссёр</h3>
            <p className="text-sm text-muted">{item.director.join(", ")}</p>
          </div>
        )}
        {item.cast.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold text-white">В ролях</h3>
            <p className="text-sm text-muted">{item.cast.join(", ")}</p>
          </div>
        )}
      </div>

      {/* Сезоны и эпизоды */}
      {item.seasons && item.seasons.length > 0 && (
        <div data-testid="seasons">
          <div className="mb-4 flex gap-2">
            {item.seasons.map((s, i) => (
              <button
        type="button"
                key={s.id}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                  i === activeSeason
                    ? "bg-accent text-white"
                    : "bg-surface-2 text-muted hover:text-white"
                }`}
                onClick={() => setActiveSeason(i)}
                data-testid="season-tab"
              >
                {s.title ?? `Сезон ${s.number}`}
              </button>
            ))}
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
            {item.seasons[activeSeason]?.episodes.map((ep) => (
              <li key={ep.id}>
                {ep.mediaId ? (
                  <Link
                    href={`/watch/${item.id}/${ep.mediaId}`}
                    className="flex items-center gap-4 px-4 py-3 transition hover:bg-surface-2"
                    data-testid="episode-row"
                  >
                    <span className="w-8 text-center text-sm font-semibold text-accent">
                      {ep.number}
                    </span>
                    {ep.thumbnailUrl && (
                      <PosterImage
                        src={ep.thumbnailUrl}
                        alt=""
                        className="h-12 w-20 rounded object-cover"
                        sizes="80px"
                      />
                    )}
                    <span className="flex-1 text-sm text-white">{ep.title ?? `Серия ${ep.number}`}</span>
                    {ep.runtime > 0 && (
                      <span className="text-xs text-muted">{formatDuration(ep.runtime)}</span>
                    )}
                  </Link>
                ) : (
                  <div className="flex items-center gap-4 px-4 py-3 opacity-50">
                    <span className="w-8 text-center text-sm">{ep.number}</span>
                    <span className="flex-1 text-sm">{ep.title ?? `Серия ${ep.number}`}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Фильм из нескольких частей */}
      {item.media && item.media.length > 1 && (
        <ul className="mt-8 divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
          {item.media.map((part) => (
            <li key={part.id}>
              <Link
                href={`/watch/${item.id}/${part.id}`}
                className="flex items-center gap-4 px-4 py-3 transition hover:bg-surface-2"
              >
                <span className="w-8 text-center text-sm font-semibold text-accent">
                  {part.partNumber}
                </span>
                <span className="flex-1 text-sm text-white">
                  {part.title ?? `Часть ${part.partNumber}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Комментарии */}
      <Comments itemId={item.id} />
    </div>
  );
}
