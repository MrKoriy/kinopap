"use client";

import type { OpsSummary } from "@zal/api-client";
import Link from "next/link";
/**
 * Ops-дашборд владельца: скорость (RUM p50/p75/p95, TTFF и холодные
 * старты), фоновые задачи (sync_state) и свежие ошибки. Данные —
 * GET /v1/metrics/summary; для Grafana есть /metrics в Prometheus-формате.
 */
import * as React from "react";
import { useOptionalAuth } from "@/lib/auth";

const HOURS = [1, 24, 24 * 7] as const;

/** Пороги Web Vitals «good» — подсветка строк. */
const GOOD: Record<string, number> = { LCP: 2500, TTFB: 800, FCP: 1800, INP: 200, CLS: 0.1, TTFF: 3000 };

function fmt(name: string, v: number | null | undefined): string {
  if (v == null) return "—";
  if (name === "CLS") return v.toFixed(3);
  return v >= 1000 ? `${(v / 1000).toFixed(2)} с` : `${Math.round(v)} мс`;
}

function ago(iso: string | null): string {
  if (!iso) return "никогда";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`;
}

export default function OpsPage() {
  const auth = useOptionalAuth();
  const api = auth?.api ?? null;
  const user = auth?.user ?? null;
  const staff = user?.role === "owner" || user?.role === "admin";
  const [hours, setHours] = React.useState<number>(24);
  const [data, setData] = React.useState<OpsSummary | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!api || !staff) return;
    let cancelled = false;
    const load = () =>
      api.getOpsSummary(hours).then(
        (d) => {
          if (!cancelled) {
            setData(d);
            setFailed(false);
          }
        },
        () => !cancelled && setFailed(true),
      );
    void load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [api, staff, hours]);

  if (!staff) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-16 text-center text-muted">
        Раздел для владельца.{" "}
        <Link href="/login" className="text-accent hover:underline">
          Войти
        </Link>
      </main>
    );
  }

  const ttff = (data?.rum.ttff ?? null) as { starts?: number; coldShare?: number | null; p50Cold?: number | null; p50Warm?: number | null } | null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8" data-testid="ops-page">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-white">Ops</h1>
        <div className="ml-auto flex gap-1">
          {HOURS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHours(h)}
              className={`rounded-full px-3 py-1 text-sm ${hours === h ? "bg-accent text-white" : "bg-surface-2 text-muted hover:text-white"}`}
            >
              {h === 1 ? "1 ч" : h === 24 ? "24 ч" : "7 дней"}
            </button>
          ))}
        </div>
      </div>
      {failed && <p className="mb-4 text-sm text-red-400">Не удалось загрузить сводку.</p>}
      {!data ? (
        <p className="text-muted">Загрузка…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
            <h2 className="mb-3 font-semibold text-white">Скорость (RUM)</h2>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted">
                <tr>
                  <th className="py-1">Метрика</th>
                  <th>p50</th>
                  <th>p75</th>
                  <th>p95</th>
                  <th>N</th>
                </tr>
              </thead>
              <tbody>
                {data.rum.metrics.map((m) => (
                  <tr key={m.name} className="border-t border-border">
                    <td className="py-1.5 text-white">{m.name}</td>
                    {[m.p50, m.p75, m.p95].map((v, i) => (
                      <td
                        key={i}
                        className={v != null && GOOD[m.name] != null && v > GOOD[m.name]! ? "text-amber-400" : "text-white/80"}
                      >
                        {fmt(m.name, v)}
                      </td>
                    ))}
                    <td className="text-muted">{m.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ttff && (ttff.starts ?? 0) > 0 && (
              <p className="mt-3 text-sm text-muted">
                Старты видео: {ttff.starts}, холодных {Math.round((ttff.coldShare ?? 0) * 100)}% · медиана холодного{" "}
                {fmt("TTFF", ttff.p50Cold)}, тёплого {fmt("TTFF", ttff.p50Warm)}
              </p>
            )}
          </section>

          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
            <h2 className="mb-3 font-semibold text-white">Фоновые задачи</h2>
            <ul className="space-y-1.5 text-sm">
              {data.sync.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${s.error ? "bg-red-500" : "bg-success"}`} />
                  <span className="text-white">{s.key}</span>
                  <span className="ml-auto text-muted">ok {ago(s.lastOkAt)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4 lg:col-span-2">
            <h2 className="mb-3 font-semibold text-white">Ошибки ({data.errors.length})</h2>
            {data.errors.length === 0 ? (
              <p className="text-sm text-muted">Ошибок нет 🎉</p>
            ) : (
              <ul className="divide-y divide-border text-sm" data-testid="ops-errors">
                {data.errors.map((e) => (
                  <li key={e.id} className="py-2">
                    <button type="button" className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <span className="shrink-0 rounded bg-surface-2 px-1.5 text-xs text-muted">{e.source}</span>
                      <span className="min-w-0 flex-1 break-words text-white">{e.message}</span>
                      <span className="shrink-0 text-xs text-muted">
                        ×{e.count} · {ago(e.lastSeen)}
                      </span>
                    </button>
                    {open === e.id && (
                      <pre className="mt-2 max-h-64 overflow-auto rounded bg-background p-2 text-xs text-muted">
                        {e.page ? `${e.page}\n` : ""}
                        {e.stack ?? "без стека"}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
