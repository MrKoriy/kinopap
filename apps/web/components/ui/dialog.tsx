"use client";

import { cn } from "@zal/ui";
import * as React from "react";
import { createPortal } from "react-dom";

/**
 * Модалка: портал в body, затемнение, закрытие по Esc и клику мимо,
 * блокировка прокрутки страницы, фокус внутрь при открытии и назад —
 * на вызвавший элемент при закрытии.
 */
export function Dialog({
  open,
  onClose,
  label,
  className,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  /** aria-label диалога. */
  label: string;
  className?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid={testId}
    >
      <button
        type="button"
        aria-label="Закрыть"
        tabIndex={-1}
        className="absolute inset-0 cursor-default"
        onClick={() => onCloseRef.current()}
      />
      <div ref={panelRef} tabIndex={-1} className={cn("relative z-10 w-full outline-none", className)}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
