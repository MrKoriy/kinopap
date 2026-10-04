import { cn } from "@zal/ui";
import { cva, type VariantProps } from "class-variance-authority";
import Link from "next/link";
import type * as React from "react";

/** Чип фильтра/тега: активный — акцентный, остальные — приглушённые. */
export const chipVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
  {
    variants: {
      active: {
        true: "bg-accent font-medium text-white hover:bg-accent-hover",
        false: "bg-surface-2 text-muted hover:bg-surface-hover hover:text-white",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 px-3 text-xs",
      },
    },
    defaultVariants: { active: false, size: "default" },
  },
);

type ChipStyle = VariantProps<typeof chipVariants>;

export function ChipLink({
  href,
  active,
  size,
  className,
  children,
  ...rest
}: ChipStyle & { href: string; className?: string; children: React.ReactNode } & Omit<
    React.ComponentProps<typeof Link>,
    "href" | "className" | "children"
  >) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(chipVariants({ active, size }), className)}
      {...rest}
    >
      {children}
    </Link>
  );
}

export function ChipButton({
  active,
  size,
  className,
  ...rest
}: ChipStyle & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-pressed={active ?? false}
      className={cn(chipVariants({ active, size }), className)}
      {...rest}
    />
  );
}
