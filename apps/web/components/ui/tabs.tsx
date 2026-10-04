"use client";

import { cn } from "@zal/ui";
import * as React from "react";

export interface TabItem {
  id: string;
  label: React.ReactNode;
  /** Счётчик рядом с подписью (серий, комментариев…). */
  count?: number;
}

/**
 * Табы-якоря: все секции страницы остаются в DOM (SEO, Ctrl+F, тесты),
 * таб прокручивает к секции, а активный подсвечивается по тому, какая
 * секция сейчас на экране (scrollspy через IntersectionObserver).
 * Стрелки ←/→ переключают фокус между табами.
 */
export function AnchorTabs({
  items,
  className,
  offset = 128,
}: {
  items: TabItem[];
  className?: string;
  /** Высота липких панелей сверху: секция «активна», когда её верх под ними. */
  offset?: number;
}) {
  const [active, setActive] = React.useState(items[0]?.id ?? "");
  const listRef = React.useRef<HTMLDivElement>(null);
  const ids = items.map((i) => i.id).join(",");

  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const sections = ids
      .split(",")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el != null);
    if (sections.length === 0) return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        // Активна верхняя из видимых секций.
        const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
        if (top) setActive(top[0]);
      },
      { rootMargin: `-${offset}px 0px -45% 0px` },
    );
    for (const s of sections) io.observe(s);
    return () => io.disconnect();
  }, [ids, offset]);

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setActive(id);
    const y = el.getBoundingClientRect().top + window.scrollY - offset + 8;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(at + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
    next?.focus();
    e.preventDefault();
  };

  if (items.length < 2) return null;
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Разделы страницы"
      onKeyDown={onKeyDown}
      className={cn(
        "flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      data-testid="item-tabs"
    >
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          aria-controls={t.id}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => go(t.id)}
          className={cn(
            "relative shrink-0 px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
            active === t.id ? "text-white" : "text-muted hover:text-white",
          )}
        >
          {t.label}
          {t.count != null && t.count > 0 && <span className="ml-1.5 text-xs opacity-60">{t.count}</span>}
          <span
            aria-hidden
            className={cn(
              "absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent transition-opacity",
              active === t.id ? "opacity-100" : "opacity-0",
            )}
          />
        </button>
      ))}
    </div>
  );
}
