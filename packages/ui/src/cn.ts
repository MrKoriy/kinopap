/**
 * Склейка классов: cn("a", cond && "b") → "a b".
 * Без зависимостей (в проекте ещё нет tailwind-merge, он появится в фазе дизайна).
 */
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
