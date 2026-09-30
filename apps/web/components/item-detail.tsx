"use client";

import type { Episode, ItemDetail, ItemProgressDto, ItemProgressEntry } from "@zal/api-client";
import { pickDefaultSeason, pluralRu, primaryPlayLabel, progressByMedia } from "@zal/shared";
import { Check, Film, Play, RotateCcw } from "lucide-react";
import Link from "next/link";
/**
 * Страница тайтла: инфо, рейтинги, кнопка «Смотреть», сезоны и эпизоды.
 * Прогресс по всему тайтлу приходит одним запросом (getItemProgress):
 * активный сезон выбирается по последней начатой серии, строки эпизодов
 * показывают, что уже просмотрено, а CTA ведёт туда, где остановились.
 */
import * as React from "react";
import { CollectionMenu } from "@/components/collection-menu";
import { Comments } from "@/components/comments";
import { FavoriteButton } from "@/components/favorite-button";
import { ItemActions } from "@/components/item-actions";
import { PosterImage } from "@/components/poster-image";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { useOptionalAuth } from "@/lib/auth";
import { formatDuration } from "@/lib/format";

/**
 * Тонкий адаптер: pickDefaultSeason выбирает сезон по id, а веб-карточка
 * открывает сезоны вкладками по индексу. null — сезон не нашли.
 */
function defaultSeasonIndex(
  item: Pick<ItemDetail, "seasons">,
  progress: ItemProgressDto | null,
): number | null {
  const seasons = item.seasons ?? [];
  const id = pickDefaultSeason(seasons, progress);
  const idx = seasons.findIndex((s) => s.id === id);
  return idx >= 0 ? idx : null;
}

/** Строка эпизода: номер, превью, название, длительность и состояние просмотра. */
function EpisodeRow({
  itemId,
  episode,
  entry,
  resume,
  prefetch,
}: {
  itemId: number;
  episode: Episode;
  entry: ItemProgressEntry | undefined;
  resume: boolean;
  prefetch: boolean;
}) {
  const label = episode.title ?? `Серия ${episode.number}`;

  if (!episode.mediaId) {
    return (
      <div className="flex items-center gap-4 px-4 py-3 opacity-50" aria-disabled="true">
        <span className="w-8 shrink-0 text-center text-sm">{episode.number}</span>
        {episode.thumbnailUrl ? (
          <span className="relative h-12 w-20 shrink-0 overflow-hidden rounded">
            <PosterImage src={episode.thumbnailUrl} alt="" className="object-cover" sizes="80px" />
          </span>
        ) : (
          <span className="h-12 w-20 shrink-0 rounded bg-surface-2" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
        {episode.runtime > 0 && (
          <span className="shrink-0 text-xs text-muted">{formatDuration(episode.runtime)}</span>
        )}
      </div>
    );
  }

  return (
    <Link
      href={`/watch/${itemId}/${episode.mediaId}`}
      prefetch={prefetch}
      className="flex items-center gap-4 px-4 py-3 transition hover:bg-surface-2"
      data-testid="episode-row"
    >
      <span className="w-8 shrink-0 text-center text-sm font-semibold text-accent">
        {episode.number}
      </span>
      {episode.thumbnailUrl ? (
        <span className="relative h-12 w-20 shrink-0 overflow-hidden rounded">
          <PosterImage src={episode.thumbnailUrl} alt="" className="object-cover" sizes="80px" />
        </span>
      ) : (
        <span className="h-12 w-20 shrink-0 rounded bg-surface-2" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-white">{label}</span>
        {resume && <span className="text-xs text-accent">Продолжить здесь</span>}
      </span>
      <EpisodeWatchState entry={entry} />
      {episode.runtime > 0 && (
        <span className="shrink-0 text-xs text-muted">{formatDuration(episode.runtime)}</span>
      )}
    </Link>
  );
}

/** Галочка «просмотрено» либо полоса прогресса начатой серии. */
function EpisodeWatchState({ entry }: { entry: ItemProgressEntry | undefined }) {
  if (!entry) return null;
  if (entry.status === "watched") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 text-xs text-success"
        data-testid="episode-watched"
      >
        <Check className="h-3.5 w-3.5" />
        просмотрено
      </span>
    );
  }
  const pct = Math.round(Math.min(1, Math.max(0, entry.progress)) * 100);
  return (
    <span className="flex w-24 shrink-0 items-center gap-2" data-testid="episode-progress">
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[10px] text-muted">{pct}%</span>
    </span>
  );
}

export function ItemDetailView({ item }: { item: ItemDetail }) {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const isAuthed = auth?.isAuthed ?? false;

  const [activeSeason, setActiveSeason] = React.useState(0);
  const [progress, setProgress] = React.useState<ItemProgressDto | null>(null);
  // Ручной выбор сезона отключает авто-выбор по прогрессу — иначе поздний
  // ответ API перепрыгнул бы туда, куда пользователь только что переключился.
  const seasonPickedByUser = React.useRef(false);

  const firstMovieMedia = item.media?.[0]?.id ?? null;
  const firstEpisodeMedia = item.seasons?.[0]?.episodes.find((e) => e.mediaId)?.mediaId ?? null;
  // Начало тайтла: первая часть фильма или S01E01 — «Смотреть»/«Сначала».
  const playMediaId = firstMovieMedia ?? firstEpisodeMedia ?? item.id;

  // Прогресс всего тайтла: галочки по сериям и точка продолжения. Гость
  // ничего не запрашивает и видит обычный список без состояния.
  React.useEffect(() => {
    if (!api || !isAuthed) return;
    let cancelled = false;
    api.getItemProgress(item.id).then(
      (res) => {
        if (!cancelled) setProgress(res.progress);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, isAuthed, item.id]);

  const resumeMediaId = progress?.resumeMediaId ?? null;

  // Активный сезон — тот, где остановился пользователь (последняя начатая
  // серия), иначе первый. Пока прогресс не пришёл, показываем первый сезон.
  React.useEffect(() => {
    if (seasonPickedByUser.current || !progress) return;
    const idx = defaultSeasonIndex(item, progress);
    if (idx != null) setActiveSeason(idx);
  }, [progress, item]);

  const entries = React.useMemo(() => progressByMedia(progress), [progress]);

  // Тихий прогрев стримов, пока пользователь читает карточку: резолвер
  // положит релиз в TorrServer и кэш API — переход «Смотреть» откроется
  // мгновенно, пиры к моменту play уже подключены.
  React.useEffect(() => {
    if (!isAuthed || !api) return;
    void api.getMediaLinks(item.id, playMediaId).catch(() => {});
  }, [api, isAuthed, item.id, playMediaId]);

  const poster = item.posters.big ?? item.posters.medium;
  const rating = item.rating > 0 ? item.rating : item.imdb.rating;

  const meta = React.useMemo(() => {
    const rows: { label: string; value: string }[] = [];
    const seasons = item.seasons ?? [];
    if (seasons.length > 0) {
      rows.push({ label: "Сезоны", value: String(seasons.length) });
      rows.push({
        label: "Серии",
        value: String(seasons.reduce((n, s) => n + s.episodes.length, 0)),
      });
    }
    if (item.media && item.media.length > 1) {
      rows.push({ label: "Части", value: String(item.media.length) });
    }
    if (item.duration.total) {
      rows.push({ label: "Общая длительность", value: formatDuration(item.duration.total) });
    }
    if (item.finished != null) {
      rows.push({ label: "Статус", value: item.finished ? "завершён" : "выходит" });
    }
    if (item.quality) rows.push({ label: "Качество", value: `${item.quality}p` });
    if (item.langs > 0) {
      const tracks = `${item.langs} ${pluralRu(item.langs, "дорожка", "дорожки", "дорожек")}`;
      rows.push({ label: "Аудио", value: item.ac3 ? `${tracks} · AC3` : tracks });
    }
    if (item.countries.length > 0) {
      rows.push({ label: "Страна", value: item.countries.map((c) => c.title).join(", ") });
    }
    if (item.imdb.rating) rows.push({ label: "IMDb", value: item.imdb.rating.toFixed(1) });
    if (item.kinopoisk.rating) {
      rows.push({ label: "Кинопоиск", value: item.kinopoisk.rating.toFixed(1) });
    }
    if (item.tmdb.rating) rows.push({ label: "TMDb", value: item.tmdb.rating.toFixed(1) });
    return rows;
  }, [item]);

  // Подпись считает @zal/shared: те же правила у мобильного клиента, и
  // написанные дважды они успели разойтись — для многочастевого фильма веб
  // писал «Продолжить» там, где мобильный писал «Продолжить Часть 2».
  const ctaMediaId = resumeMediaId ?? playMediaId;
  const ctaLabel = primaryPlayLabel(item, resumeMediaId);
  const showStartOver = resumeMediaId != null && resumeMediaId !== playMediaId;

  const activeEpisodes = item.seasons?.[activeSeason]?.episodes ?? [];
  const firstPlayableInSeason = activeEpisodes.find((e) => e.mediaId)?.mediaId ?? null;

  return (
    <div>
      {/* Шапка — карточка с постером слева, инфо справа. Никакого full-bleed,
          чтобы не выглядело как трейлер на всю карточку. */}
      <div className="mb-8 flex flex-col gap-6 rounded-[var(--radius-card)] border border-border bg-surface-2 p-6 sm:flex-row sm:items-start">
        <div className="mx-auto w-[200px] shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-background sm:mx-0 sm:w-[220px]">
          {poster ? (
            <PosterImage
              src={poster}
              alt={item.title}
              className="aspect-[2/3] w-full object-cover"
              sizes="220px"
              priority
              fill={false}
              width={220}
              height={330}
            />
          ) : (
            <div className="flex aspect-[2/3] w-full items-center justify-center bg-surface-2 text-muted">
              <Film className="h-10 w-10 opacity-30" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold text-white sm:text-4xl" data-testid="item-title">
            {item.title}
          </h1>
          {item.originalTitle && <p className="mt-1 text-sm text-muted">{item.originalTitle}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {rating !== null && rating > 0 && (
              <Badge className="bg-accent text-white">★ {rating.toFixed(1)}</Badge>
            )}
            {item.year && <Badge>{item.year}</Badge>}
            {item.genres.map((g) => (
              <Badge key={g.id}>{g.title}</Badge>
            ))}
            {item.duration.average ? <Badge>{formatDuration(item.duration.average)}</Badge> : null}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link
              href={`/watch/${item.id}/${ctaMediaId}`}
              className={buttonVariants()}
              data-testid="watch-button"
            >
              <Play className="mr-2 h-4 w-4 fill-current" />
              {ctaLabel}
            </Link>

            {showStartOver && (
              <Link
                href={`/watch/${item.id}/${playMediaId}`}
                className={buttonVariants({ variant: "secondary" })}
                data-testid="watch-from-start"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Сначала
              </Link>
            )}

            <FavoriteButton itemId={item.id} />

            <CollectionMenu itemId={item.id} />

            <div className="self-center">
              <ItemActions itemId={item.id} />
            </div>
          </div>
        </div>
      </div>

      {/* Мета-сетка: тип-зависимые детали — сезоны, качество, озвучка, рейтинги */}
      {meta.length > 0 && (
        <dl
          className="mb-8 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4"
          data-testid="meta-grid"
        >
          {meta.map((row) => (
            <div key={row.label}>
              <dt className="text-xs uppercase tracking-wide text-muted">{row.label}</dt>
              <dd className="mt-0.5 text-sm text-white">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* Описание */}
      {item.plot && (
        <p className="mb-8 max-w-3xl leading-relaxed text-muted" data-testid="item-plot">
          {item.plot}
        </p>
      )}

      {/* Создатели */}
      {(item.director.length > 0 || item.cast.length > 0) && (
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
      )}

      {/* Сезоны и эпизоды */}
      {item.seasons ? (
        item.seasons.length > 0 ? (
        <div data-testid="seasons">
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
            {item.seasons.map((s, i) => (
              <button
                type="button"
                key={s.id}
                className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                  i === activeSeason
                    ? "bg-accent text-white"
                    : "bg-surface-2 text-muted hover:text-white"
                }`}
                onClick={() => {
                  seasonPickedByUser.current = true;
                  setActiveSeason(i);
                }}
                data-testid="season-tab"
              >
                {s.title ?? `Сезон ${s.number}`}
                <span className="ml-1.5 text-xs opacity-70">{s.episodes.length}</span>
              </button>
            ))}
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
            {activeEpisodes.map((ep) => (
              <li key={ep.id}>
                <EpisodeRow
                  itemId={item.id}
                  episode={ep}
                  entry={ep.mediaId != null ? entries.get(ep.mediaId) : undefined}
                  resume={ep.mediaId != null && ep.mediaId === resumeMediaId}
                  prefetch={ep.mediaId != null && ep.mediaId === firstPlayableInSeason}
                />
              </li>
            ))}
          </ul>
        </div>
        ) : (
          <div className="mb-8 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
            Сезоны загружаются… Обновите страницу через несколько секунд.
          </div>
        )
      ) : null}

      {/* Фильм из нескольких частей (аниме без сезонов — тоже) */}
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
