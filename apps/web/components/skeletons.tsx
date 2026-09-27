/** Скелетоны загрузки: карточки, ленты, страница тайтла. */
export function CardSkeleton() {
  return (
    <div className="w-40 shrink-0 sm:w-48">
      <div className="aspect-[2/3] w-full animate-pulse rounded-[var(--radius-card)] bg-surface-2" />
      <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-surface-2" />
    </div>
  );
}

export function RailSkeleton({ count = 6 }: { count?: number }) {
  return (
    <section className="mb-10">
      <div className="mb-4 h-6 w-48 animate-pulse rounded bg-surface-2" />
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: count }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}

export function HeroSkeleton() {
  return (
    <div className="mb-10 h-[420px] w-full animate-pulse rounded-[var(--radius-card)] bg-surface-2 sm:h-[520px]" />
  );
}

export function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-[380px] w-full animate-pulse rounded-[var(--radius-card)] bg-surface-2" />
      <div className="h-8 w-1/2 animate-pulse rounded bg-surface-2" />
      <div className="h-4 w-full animate-pulse rounded bg-surface-2" />
      <div className="h-4 w-5/6 animate-pulse rounded bg-surface-2" />
    </div>
  );
}
