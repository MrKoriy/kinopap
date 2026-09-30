export default function ItemLoading() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8" data-testid="item-loading">
      <div className="mb-8 flex flex-col gap-6 rounded-[var(--radius-card)] border border-border bg-surface-2 p-6 sm:flex-row">
        <div className="mx-auto aspect-[2/3] w-[200px] shrink-0 animate-pulse rounded-[var(--radius-card)] bg-surface sm:mx-0 sm:w-[220px]" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="h-8 w-2/3 animate-pulse rounded bg-surface" />
          <div className="h-4 w-1/3 animate-pulse rounded bg-surface" />
          <div className="mt-4 flex gap-2">
            <div className="h-6 w-16 animate-pulse rounded-full bg-surface" />
            <div className="h-6 w-16 animate-pulse rounded-full bg-surface" />
          </div>
          <div className="mt-4 h-10 w-28 animate-pulse rounded-full bg-surface" />
        </div>
      </div>
    </main>
  );
}
