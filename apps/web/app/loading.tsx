/** Общий скелет навигации между маршрутами. */
export default function LoadingPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8" data-testid="route-loading">
      <div className="mb-8 h-[380px] animate-pulse rounded-[var(--radius-card)] bg-surface-2" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="aspect-[2/3] animate-pulse rounded-[var(--radius-card)] bg-surface-2"
          />
        ))}
      </div>
    </main>
  );
}
