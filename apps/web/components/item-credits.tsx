import type { ItemDetail, PersonCredit } from "@zal/api-client";
import { User } from "lucide-react";
import Link from "next/link";
import { PosterImage } from "@/components/poster-image";

const CREW_LABEL: Record<string, string> = {
  director: "Режиссёр",
  writer: "Сценарий",
  producer: "Продюсер",
  composer: "Композитор",
};

/** Фото 2:3 или силуэт — ширина фиксирована, CLS = 0. */
function PersonPhoto({ person }: { person: PersonCredit }) {
  return (
    <span className="relative block aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface-2">
      {person.photoUrl ? (
        <PosterImage src={person.photoUrl} alt={person.name} className="object-cover" sizes="96px" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted">
          <User className="h-8 w-8 opacity-30" />
        </span>
      )}
    </span>
  );
}

/**
 * «Актёры и команда»: топ актёров лентой с фото и ролью, команда строкой.
 * Имя ведёт в поиск по человеку (фильмография в нашем каталоге).
 */
export function ItemCredits({ credits }: { credits: NonNullable<ItemDetail["credits"]> }) {
  if (credits.cast.length === 0 && credits.crew.length === 0) return null;
  const crewByRole = new Map<string, string[]>();
  for (const p of credits.crew) {
    const list = crewByRole.get(p.role) ?? [];
    list.push(p.name);
    crewByRole.set(p.role, list);
  }
  return (
    <section className="mb-8" data-testid="credits">
      <h2 className="mb-3 text-lg font-semibold text-white">Актёры и команда</h2>
      {crewByRole.size > 0 && (
        <dl className="mb-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {[...crewByRole].map(([role, names]) => (
            <div key={role}>
              <dt className="text-xs uppercase tracking-wide text-muted">{CREW_LABEL[role] ?? role}</dt>
              <dd className="mt-0.5 text-white">
                {names.map((n, i) => (
                  <span key={n}>
                    {i > 0 && ", "}
                    <Link
                      href={`/search?q=${encodeURIComponent(n)}${role === "director" ? "&field=director" : ""}`}
                      className="hover:text-accent"
                    >
                      {n}
                    </Link>
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {credits.cast.length > 0 && (
        <ul className="flex gap-3 overflow-x-auto pb-2" data-testid="cast-list">
          {credits.cast.map((p) => (
            <li key={p.id} className="w-24 shrink-0">
              <Link href={`/search?q=${encodeURIComponent(p.name)}&field=cast`} className="group block">
                <PersonPhoto person={p} />
                <span className="mt-1.5 block truncate text-xs font-medium text-white group-hover:text-accent">
                  {p.name}
                </span>
                {p.character && <span className="block truncate text-[11px] text-muted">{p.character}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const FORMAT_LABEL: Record<string, string> = {
  TV: "ТВ",
  TV_SHORT: "ТВ",
  MOVIE: "Фильм",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "Спешл",
};

/** «Франшиза»: сезоны, фильмы и OVA по порядку выхода; текущий тайтл подсвечен. */
export function ItemFranchise({ franchise, itemId }: { franchise: NonNullable<ItemDetail["franchise"]>; itemId: number }) {
  return (
    <section className="mb-8" data-testid="franchise">
      <h2 className="mb-3 text-lg font-semibold text-white">Франшиза</h2>
      <ol className="divide-y divide-border overflow-hidden rounded-[var(--radius-card)] border border-border">
        {franchise.entries.map((e, i) => {
          const current = e.itemId === itemId;
          const body = (
            <>
              <span className="w-6 shrink-0 text-center text-sm tabular-nums text-muted">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-white">{e.title}</span>
              <span className="shrink-0 rounded bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                {FORMAT_LABEL[e.format ?? ""] ?? e.format ?? "—"}
              </span>
              {e.episodes && e.episodes > 1 ? (
                <span className="w-16 shrink-0 text-right text-xs text-muted">{e.episodes} сер.</span>
              ) : (
                <span className="w-16 shrink-0" />
              )}
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">{e.year ?? ""}</span>
            </>
          );
          return (
            <li key={e.anilistId} data-testid="franchise-entry">
              {e.itemId && !current ? (
                <Link href={`/item/${e.itemId}`} className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-surface-2">
                  {body}
                </Link>
              ) : (
                <div
                  className={`flex items-center gap-3 px-4 py-2.5 ${current ? "bg-accent/10" : "opacity-60"}`}
                  aria-current={current ? "page" : undefined}
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
