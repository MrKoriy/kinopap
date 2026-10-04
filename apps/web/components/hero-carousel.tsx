"use client";

/**
 * Hero главной: крупные тайтлы с бэкдропом, мета-строкой и беззвучным
 * превью трейлера (десктоп). Авто-ротация каждые 7 с; пока крутится превью —
 * слайд держится до конца клипа (30 с), наведение/фокус ставят на паузу.
 */
import { ITEM_TYPE_TITLES, type ItemSummary } from "@zal/api-client";
import { Info, Play } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { PosterImage } from "@/components/poster-image";
import { TrailerButton, youtubeId } from "@/components/trailer-button";
import { canAutoPreview, MutedTrailer } from "@/components/trailer-preview";
import { displayRating, formatDurationHuman } from "@/lib/format";
import { backdropFor } from "@/lib/images";

const ROTATE_MS = 7000;
/** Длительность кроссфейда — столько держим уходящий слайд под входящим. */
const FADE_MS = 800;
/** Через сколько после показа слайда стартует превью трейлера. */
const PREVIEW_DELAY_MS = 1800;
/** Длина клипа превью: после него слайд сменяется. */
const PREVIEW_MS = 30_000;

function HeroImage({ item, priority }: { item: ItemSummary; priority?: boolean }) {
  const { src, isPoster } = backdropFor(item);
  return (
    <PosterImage
      src={src}
      alt=""
      className={`h-full w-full object-cover ${isPoster ? "object-[50%_25%]" : "object-center"}`}
      sizes="(max-width: 1280px) 100vw, 1280px"
      priority={priority}
    />
  );
}

export function HeroCarousel({ items }: { items: ItemSummary[] }) {
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const [reducedMotion, setReducedMotion] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [previewAllowed, setPreviewAllowed] = React.useState(false);
  // Уходящий слайд: лежит под входящим, пока идёт fade (keyframes в globals.css).
  const [fading, setFading] = React.useState<ItemSummary | null>(null);
  const indexRef = React.useRef(0);
  const fadeTimer = React.useRef<number | null>(null);

  const goTo = React.useCallback(
    (next: number) => {
      const current = indexRef.current;
      if (next === current || next < 0 || next >= items.length) return;
      indexRef.current = next;
      setFading(items[current] ?? null);
      setPreviewing(false);
      setIndex(next);
      if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
      fadeTimer.current = window.setTimeout(() => setFading(null), FADE_MS);
    },
    [items],
  );

  // Таймер снятия уходящего слоя не должен пережить компонент.
  React.useEffect(
    () => () => {
      if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    },
    [],
  );

  // prefers-reduced-motion: без авто-движения, слайды меняются только кликом.
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReducedMotion(mq.matches);
    apply();
    setPreviewAllowed(canAutoPreview());
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const item = items[index];
  const trailerId = item ? youtubeId(item.trailer) : null;

  // Превью трейлера текущего слайда — с задержкой, чтобы не грузить YouTube
  // на каждый мимолётный слайд.
  React.useEffect(() => {
    if (!previewAllowed || !trailerId) return;
    const t = window.setTimeout(() => setPreviewing(true), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [previewAllowed, trailerId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: index перезапускает таймер на каждом новом слайде.
  React.useEffect(() => {
    if (items.length < 2 || paused || reducedMotion) return;
    const id = window.setTimeout(
      () => goTo((indexRef.current + 1) % items.length),
      previewing ? PREVIEW_MS : ROTATE_MS,
    );
    return () => window.clearTimeout(id);
  }, [items.length, paused, reducedMotion, goTo, previewing, index]);

  if (!item) return null;
  const rating = displayRating(item);
  const meta = [
    item.year,
    ITEM_TYPE_TITLES[item.type],
    item.countries[0]?.title,
    item.duration.average ? formatDurationHuman(item.duration.average) : null,
  ].filter(Boolean);

  return (
    <section
      className="relative mb-10 h-[440px] overflow-hidden rounded-[var(--radius-card)] bg-surface sm:h-[540px]"
      data-testid="hero"
      aria-roledescription="карусель"
      aria-label={item.title}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {fading && fading.id !== item.id && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <HeroImage item={fading} />
        </div>
      )}

      <div key={item.id} className="hero-slide absolute inset-0">
        <HeroImage item={item} priority={index === 0} />
        {previewing && trailerId && <MutedTrailer youtubeId={trailerId} title={item.title} />}
      </div>
      {/* Затемнение: слева под текстом и снизу под точками. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-black via-black/60 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />

      <div key={`copy-${item.id}`} className="hero-copy absolute bottom-12 left-6 right-6 max-w-xl sm:left-12">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/75">
          {rating != null && rating > 0 && (
            <span className={`font-semibold ${rating >= 7 ? "text-emerald-400" : rating >= 5 ? "text-amber-400" : ""}`}>
              ★ {rating.toFixed(1)}
            </span>
          )}
          {meta.map((m) => (
            <span key={String(m)} className="after:ml-3 after:text-white/30 after:content-['•'] last:after:hidden">
              {m}
            </span>
          ))}
        </div>
        <h1 className="text-4xl font-bold leading-tight text-white drop-shadow-lg sm:text-display">{item.title}</h1>
        {item.plot && <p className="mt-3 line-clamp-3 text-sm text-white/75 sm:text-base">{item.plot}</p>}
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href={`/item/${item.id}`}
            className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white shadow-glow transition hover:bg-accent-hover"
          >
            <Play className="h-4 w-4 fill-current" /> Смотреть
          </Link>
          <TrailerButton
            trailer={item.trailer}
            title={item.title}
            onOpenChange={(open) => setPaused(open)}
            className="glass inline-flex items-center rounded-full border px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/15"
          />
          <Link
            href={`/item/${item.id}`}
            className="glass inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/15"
          >
            <Info className="h-4 w-4" /> Подробнее
          </Link>
        </div>
      </div>

      {items.length > 1 && (
        <div className="absolute bottom-5 right-6 flex gap-2 sm:right-8">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              aria-label={`Слайд ${i + 1}: ${it.title}`}
              aria-current={i === index ? "true" : undefined}
              onClick={() => goTo(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? "w-8 bg-accent" : "w-4 bg-white/30 hover:bg-white/50"
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
