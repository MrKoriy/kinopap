"use client";

import type { ItemSummary } from "@zal/api-client";
import Link from "next/link";
/** Hero-карусель: крупные тайтлы с авто-ротацией и переходом к просмотру. */
import * as React from "react";
import { PosterImage } from "@/components/poster-image";

const ROTATE_MS = 6000;
/** Длительность кроссфейда — столько держим уходящий слайд под входящим. */
const FADE_MS = 800;

export function HeroCarousel({ items }: { items: ItemSummary[] }) {
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const [reducedMotion, setReducedMotion] = React.useState(false);
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
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  React.useEffect(() => {
    if (items.length < 2 || paused || reducedMotion) return;
    const id = window.setInterval(
      () => goTo((indexRef.current + 1) % items.length),
      ROTATE_MS,
    );
    return () => window.clearInterval(id);
  }, [items.length, paused, reducedMotion, goTo]);

  if (items.length === 0) return null;
  const item = items[index]!;
  const backdrop = item.posters.big ?? item.posters.medium;

  return (
    <section
      className="relative mb-10 h-[420px] overflow-hidden rounded-[var(--radius-card)] sm:h-[520px]"
      data-testid="hero"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {fading && fading.id !== item.id && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <PosterImage
            src={fading.posters.big ?? fading.posters.medium}
            alt=""
            className="h-full w-full object-cover"
            sizes="100vw"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent" />
        </div>
      )}

      <div key={item.id} className="hero-slide absolute inset-0">
        <PosterImage
          src={backdrop}
          alt={item.title}
          className="h-full w-full object-cover"
          sizes="100vw"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent" />
      </div>

      <div
        key={`copy-${item.id}`}
        className="hero-copy absolute bottom-12 left-8 max-w-xl sm:left-12"
      >
        <p className="mb-2 text-sm uppercase tracking-widest text-accent">
          {[item.year, item.countries[0]?.title].filter(Boolean).join(" · ")}
        </p>
        <h1 className="text-4xl font-bold text-white sm:text-5xl">{item.title}</h1>
        {item.plot && (
          <p className="mt-3 line-clamp-2 text-sm text-white/70 sm:text-base">{item.plot}</p>
        )}
        <div className="mt-6 flex gap-3">
          <Link
            href={`/item/${item.id}`}
            className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-hover"
          >
            Смотреть
          </Link>
          <Link
            href={`/item/${item.id}`}
            className="rounded-full border border-white/20 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
          >
            Подробнее
          </Link>
        </div>
      </div>

      {items.length > 1 && (
        <div className="absolute bottom-5 right-8 flex gap-2">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              aria-label={`Слайд ${i + 1}`}
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
