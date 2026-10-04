import { cn } from "@zal/ui";
import type * as React from "react";

/**
 * Подсказка на чистом CSS: показывается при hover и focus-within, без
 * порталов и таймеров. Для иконок-кнопок, у которых нет подписи.
 */
export function Tooltip({
  label,
  side = "top",
  children,
  className,
}: {
  label: string;
  side?: "top" | "bottom";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("group/tt relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-[60] -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-black/90 px-2 py-1 text-xs text-white opacity-0 shadow-lg transition-opacity duration-150 group-focus-within/tt:opacity-100 group-hover/tt:opacity-100",
          side === "top" ? "bottom-full mb-2" : "top-full mt-2",
        )}
      >
        {label}
      </span>
    </span>
  );
}
