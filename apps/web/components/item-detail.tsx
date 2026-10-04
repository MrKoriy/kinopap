"use client";

import type { Episode, ItemDetail, ItemProgressDto, ItemProgressEntry, ItemSummary } from "@zal/api-client";
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
import { ItemCredits, ItemFranchise } from "@/components/item-credits";
import { ItemPoster } from "@/components/item-poster";
import { ItemRail } from "@/components/item-rail";
import { PosterImage } from "@/components/poster-image";
import { TrailerButton } from "@/components/trailer-button";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { AnchorTabs, type TabItem } from "@/components/ui/tabs";
import { useOptionalAuth } from "@/lib/auth";
import { formatDurationHuman } from "@/lib/format";
import { backdropFor } from "@/lib/images";

/**
 * Тонкий адаптер: pickDefaultSeason выбирает сезон по id, а веб-карточка
 * открывает сезоны вкладками по индексу. null — сезон не нашли.
 */
/** Серий на один диапазон длинного сезона. */
const EPISODE_CHUNK = 50;

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
          <span className="shrink-0 text-xs text-muted">{formatDurationHuman(episode.runtime)}</span>
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
        <span className="shrink-0 text-xs text-muted">{formatDurationHuman(episode.runtime)}</span>
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

/** Поле «Серия №» для длинных сезонов: Enter — прыжок к строке серии. */
function EpisodeJump({ onJump }: { onJump: (n: number) => boolean }) {
  const [value, setValue] = React.useState("");
  const [miss, setMiss] = React.useState(false);
  return (
    <form
      className="mb-3 flex items-center gap-2"
      data-testid="episode-jump"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number.parseInt(value, 10);
        setMiss(!(n > 0 && onJump(n)));
      }}
    >
      <input
        type="number"
        min={1}
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setMiss(false);
        }}
        placeholder="Серия №"
        aria-label="Перейти к серии по номеру"
        className="h-8 w-28 rounded-md border border-border bg-surface-2 px-2 text-sm text-white placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <button type="submit" className="h-8 rounded-md bg-surface-2 px-3 text-xs font-medium text-muted transition hover:text-white">
        Найти
      </button>
      {miss && <span className="text-xs text-muted">Нет такой серии</span>}
    </form>
  );
}

export function ItemDetailView({ item, similar = [] }: { item: ItemDetail; similar?: ItemSummary[] }) {
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
  // Гостям тоже: смотреть можно без входа.
  React.useEffect(() => {
    if (!api) return;
    void api.getMediaLinks(item.id, playMediaId).catch(() => {});
  }, [api, item.id, playMediaId]);

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
      rows.push({ label: "Общая длительность", value: formatDurationHuman(item.duration.total) });
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

  // Вкладки: обычные сезоны + «Спецвыпуски» (TMDb «Сезон 0») последней.
  const seasonTabs = React.useMemo(
    () => [...(item.seasons ?? []), ...(item.specials ? [{ ...item.specials, title: "Спецвыпуски" }] : [])],
    [item.seasons, item.specials],
  );
  const activeEpisodes = seasonTabs[activeSeason]?.episodes ?? [];
  const firstPlayableInSeason = activeEpisodes.find((e) => e.mediaId)?.mediaId ?? null;

  // Длинный сезон (мыльные оперы, аниме без раскладки) режем на диапазоны
  // «1–50, 51–100…»: 1000 строк разом — секунды рендера и бесконечный скролл.
  const chunked = activeEpisodes.length > EPISODE_CHUNK + EPISODE_CHUNK / 5;
  const [activeChunk, setActiveChunk] = React.useState(0);
  const pendingChunk = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (pendingChunk.current != null) {
      setActiveChunk(pendingChunk.current);
      pendingChunk.current = null;
      return;
    }
    const at = resumeMediaId != null ? activeEpisodes.findIndex((e) => e.mediaId === resumeMediaId) : -1;
    setActiveChunk(at > 0 ? Math.floor(at / EPISODE_CHUNK) : 0);
  }, [activeEpisodes, resumeMediaId]);
  const chunks = chunked
    ? Array.from({ length: Math.ceil(activeEpisodes.length / EPISODE_CHUNK) }, (_, i) => {
        const part = activeEpisodes.slice(i * EPISODE_CHUNK, (i + 1) * EPISODE_CHUNK);
        return `${part[0]?.number ?? i * EPISODE_CHUNK + 1}–${part.at(-1)?.number ?? (i + 1) * EPISODE_CHUNK}`;
      })
    : [];
  const visibleEpisodes = chunked
    ? activeEpisodes.slice(activeChunk * EPISODE_CHUNK, (activeChunk + 1) * EPISODE_CHUNK)
    : activeEpisodes;

  // «Серия №»: сначала в открытом сезоне, затем по сквозному номеру через
  // все сезоны (после раскладки на куры «Блич 245» живёт в «Сезоне 10»).
  const [highlight, setHighlight] = React.useState<number | null>(null);
  const jumpToEpisode = (n: number): boolean => {
    let season = activeSeason;
    let at = activeEpisodes.findIndex((e) => e.number === n);
    if (at < 0) {
      let left = n;
      season = -1;
      for (let i = 0; i < seasonTabs.length; i++) {
        const tab = seasonTabs[i]!;
        if (tab.number === 0) continue;
        if (left <= tab.episodes.length) {
          season = i;
          at = left - 1;
          break;
        }
        left -= tab.episodes.length;
      }
      if (season < 0) return false;
    }
    const ep = seasonTabs[season]?.episodes[at];
    if (!ep) return false;
    seasonPickedByUser.current = true;
    setActiveSeason(season);
    pendingChunk.current = Math.floor(at / EPISODE_CHUNK);
    setActiveChunk(pendingChunk.current);
    setHighlight(ep.id);
    window.requestAnimationFrame(() =>
      window.setTimeout(() => document.getElementById(`ep-${ep.id}`)?.scrollIntoView({ block: "center" }), 50),
    );
    return true;
  };

  const backdrop = backdropFor(item);
  const tint = item.images?.color ?? null;
  const metaLine = [
    item.year ? String(item.year) : null,
    item.countries.length > 0 ? item.countries.slice(0, 2).map((c) => c.title).join(", ") : null,
    item.duration.average ? formatDurationHuman(item.duration.average) : null,
  ].filter((v): v is string => v != null);
  const ratings = [
    item.kinopoisk.rating ? { label: "КП", value: item.kinopoisk.rating } : null,
    item.imdb.rating ? { label: "IMDb", value: item.imdb.rating } : null,
    item.tmdb.rating ? { label: "TMDb", value: item.tmdb.rating } : null,
  ].filter((v): v is { label: string; value: number } => v != null);

  const hasEpisodes = item.seasons != null || (item.media != null && item.media.length > 1);
  const hasCredits =
    (item.credits != null && (item.credits.cast.length > 0 || item.credits.crew.length > 0)) ||
    item.director.length > 0 ||
    item.cast.length > 0;
  const tabs: TabItem[] = [
    ...(hasEpisodes
      ? [{ id: "episodes", label: item.seasons ? "Серии" : "Части", count: item.seasons ? undefined : item.media?.length }]
      : []),
    { id: "about", label: "О фильме" },
    ...(hasCredits ? [{ id: "cast", label: "Актёры" }] : []),
    ...(similar.length > 0 ? [{ id: "similar", label: "Похожее" }] : []),
    { id: "comments", label: "Отзывы" },
  ];

  return (
    <div>
      {/* Шапка: бэкдроп приглушённым фоном за карточкой постер+инфо. */}
      <div
        className="relative mb-6 overflow-hidden rounded-2xl border border-border bg-surface-2 shadow-card"
        style={tint ? { backgroundColor: tint } : undefined}
      >
        {backdrop.src && (
          <div aria-hidden className="absolute inset-0">
            <PosterImage
              src={backdrop.src}
              alt=""
              className={`object-cover ${backdrop.isPoster ? "scale-110 opacity-30 blur-2xl" : "opacity-45"}`}
              sizes="(max-width: 1280px) 100vw, 1280px"
              priority
            />
            <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
          </div>
        )}
        <div className="relative flex flex-col gap-6 p-6 sm:flex-row sm:items-end sm:p-8">
          <div className="relative mx-auto w-[200px] shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-background shadow-card sm:mx-0 sm:w-[220px]">
            {poster ? (
              <ItemPoster
                item={item}
                fallbackSrc={poster}
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
            <h1 className="text-3xl font-bold text-white sm:text-4xl lg:text-5xl" data-testid="item-title">
              {item.title}
            </h1>
            {item.originalTitle && <p className="mt-1 text-sm text-muted">{item.originalTitle}</p>}
            {(metaLine.length > 0 || ratings.length > 0) && (
              <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-white/80" data-testid="item-meta-line">
                {metaLine.map((v, i) => (
                  <React.Fragment key={v}>
                    {i > 0 && <span className="text-muted">•</span>}
                    <span>{v}</span>
                  </React.Fragment>
                ))}
                {ratings.map((r) => (
                  <span key={r.label} className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-xs font-semibold tabular-nums">
                    {r.label} {r.value.toFixed(1)}
                  </span>
                ))}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {rating !== null && rating > 0 && <Badge className="bg-accent text-white">★ {rating.toFixed(1)}</Badge>}
              {item.genres.map((g) => (
                <Badge key={g.id}>{g.title}</Badge>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Link href={`/watch/${item.id}/${ctaMediaId}`} className={buttonVariants()} data-testid="watch-button">
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

              <TrailerButton trailer={item.trailer} title={item.title} />

              <FavoriteButton itemId={item.id} />

              <CollectionMenu itemId={item.id} />

              <div className="self-center">
                <ItemActions itemId={item.id} />
              </div>
            </div>
            {item.plot && (
              <p className="mt-5 line-clamp-3 max-w-3xl text-sm leading-relaxed text-white/75 sm:text-base">{item.plot}</p>
            )}
          </div>
        </div>
      </div>

      {/* Табы-якоря: липнут под шапкой сайта, подсвечивают видимую секцию. */}
      <AnchorTabs items={tabs} className="glass sticky top-16 z-30 mb-6 -mx-4 px-4" />

      {/* Сезоны и эпизоды / части фильма */}
      {hasEpisodes && (
        <section id="episodes" className="mb-10 scroll-mt-32">
          {item.seasons ? (
            seasonTabs.length > 0 ? (
              <div data-testid="seasons">
                <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
                  {seasonTabs.map((s, i) => (
                    <button
                      type="button"
                      key={s.id}
                      className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                        i === activeSeason ? "bg-accent text-white" : "bg-surface-2 text-muted hover:text-white"
                      }`}
                      onClick={() => {
                        seasonPickedByUser.current = true;
                        setActiveSeason(i);
                      }}
                      data-testid={s.number === 0 ? "specials-tab" : "season-tab"}
                    >
                      {s.title ?? `Сезон ${s.number}`}
                      <span className="ml-1.5 text-xs opacity-70">{s.episodes.length}</span>
                    </button>
                  ))}
                </div>
                {(chunked || seasonTabs.length > 4) && <EpisodeJump onJump={jumpToEpisode} />}
                {chunked && (
                  <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1" data-testid="episode-ranges">
                    {chunks.map((label, i) => (
                      <button
                        type="button"
                        key={label}
                        className={`shrink-0 rounded-md px-3 py-1 text-xs font-medium tabular-nums transition ${
                          i === activeChunk ? "bg-white/15 text-white" : "bg-surface-2 text-muted hover:text-white"
                        }`}
                        onClick={() => setActiveChunk(i)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
                  {visibleEpisodes.map((ep) => (
                    <li
                      key={ep.id}
                      id={`ep-${ep.id}`}
                      className={highlight === ep.id ? "bg-accent/10 ring-1 ring-inset ring-accent" : undefined}
                    >
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
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
                Сезоны загружаются… Обновите страницу через несколько секунд.
              </div>
            )
          ) : null}

          {/* Фильм из нескольких частей (аниме без сезонов — тоже) */}
          {item.media && item.media.length > 1 && (
            <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
              {item.media.map((part) => (
                <li key={part.id}>
                  <Link
                    href={`/watch/${item.id}/${part.id}`}
                    className="flex items-center gap-4 px-4 py-3 transition hover:bg-surface-2"
                  >
                    <span className="w-8 text-center text-sm font-semibold text-accent">{part.partNumber}</span>
                    <span className="flex-1 text-sm text-white">{part.title ?? `Часть ${part.partNumber}`}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* О фильме: сюжет целиком и мета-сетка */}
      <section id="about" className="mb-10 scroll-mt-32">
        {item.plot && (
          <p className="mb-6 max-w-3xl leading-relaxed text-muted" data-testid="item-plot">
            {item.plot}
          </p>
        )}
        {meta.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="meta-grid">
            {meta.map((row) => (
              <div key={row.label}>
                <dt className="text-xs uppercase tracking-wide text-muted">{row.label}</dt>
                <dd className="mt-0.5 text-sm text-white">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {/* Франшиза (аниме): сезоны, фильмы, OVA по порядку */}
        {item.franchise && item.franchise.entries.length > 1 && (
          <div className="mt-8">
            <ItemFranchise franchise={item.franchise} itemId={item.id} />
          </div>
        )}
      </section>

      {/* Актёры и команда: фото, роли; старые карточки — строкой имён */}
      {hasCredits && (
        <section id="cast" className="mb-2 scroll-mt-32">
          {item.credits && (item.credits.cast.length > 0 || item.credits.crew.length > 0) ? (
            <ItemCredits credits={item.credits} />
          ) : (
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
        </section>
      )}

      {similar.length > 0 && (
        <section id="similar" className="mb-10 scroll-mt-32">
          <ItemRail title="Похожее" items={similar} />
        </section>
      )}

      {/* Комментарии */}
      <section id="comments" className="scroll-mt-32">
        <Comments itemId={item.id} />
      </section>
    </div>
  );
}
