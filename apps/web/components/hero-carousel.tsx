"use client";

import type { ItemSummary } from "@zal/api-client";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
/** Hero-карусель: крупные тайтлы с авто-ротацией и переходом к просмотру. */
import * as React from "react";
import { PosterImage } from "@/components/poster-image";

const ROTATE_MS = 6000;

export function HeroCarousel({ items }: { items: ItemSummary[] }) {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    if (items.length < 2) return;
    const id = window.setInterval(
      () => setIndex((i) => (i + 1) % items.length),
      ROTATE_MS,
    );
    return () => window.clearInterval(id);
  }, [items.length]);

  if (items.length === 0) return null;
  const item = items[index]!;
  const backdrop = item.posters.big ?? item.posters.medium;

  return (
    <section
      className="relative mb-10 h-[420px] overflow-hidden rounded-[var(--radius-card)] sm:h-[520px]"
      data-testid="hero"
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={item.id}
          initial={{ opacity: 0, scale: 1.05 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="absolute inset-0"
        >
          <PosterImage
            src={backdrop}
            alt={item.title}
            className="h-full w-full object-cover"
            sizes="100vw"
            priority
          />
          <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent" />
        </motion.div>
      </AnimatePresence>

      <motion.div
        key={`copy-${item.id}`}
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="absolute bottom-12 left-8 max-w-xl sm:left-12"
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
      </motion.div>

      {items.length > 1 && (
        <div className="absolute bottom-5 right-8 flex gap-2">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              aria-label={`Слайд ${i + 1}`}
              onClick={() => setIndex(i)}
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
