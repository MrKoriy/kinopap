"use client";

import type { ItemDetail, MediaLinks } from "@zal/api-client";
/**
 * Клиентская часть watch-страницы: подтягивает media-links после рендера.
 * Zero-storage резолв может ходить в rutor/TMDb до ~10 секунд — раньше
 * SSR страницы блокировался на этот срок («страница грузится вечно»).
 * Теперь страница рисуется сразу, источники ищутся под спиннером.
 */
import * as React from "react";
import { Player, type PlayerNext } from "@/components/player/player";
import { useAuth } from "@/lib/auth";

export function WatchClient({
  item,
  mediaId,
  next,
}: {
  item: ItemDetail;
  mediaId: number;
  next: PlayerNext | null;
}) {
  const { api } = useAuth();
  const [links, setLinks] = React.useState<MediaLinks | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [playbackStarted, setPlaybackStarted] = React.useState(false);
  // Прогрев следующей серии — один раз на пару (itemId, mediaId).
  const prefetchedNext = React.useRef<string | null>(null);

  // Пока идёт поиск — считаем секунды и показываем стадию: резолвер
  // сначала ищет релизы в rutor (до ~6с), потом прогревает торрент
  // (budget 2.5с), потом клиент собирает манифест.
  React.useEffect(() => {
    if (links || failed) return;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => window.clearInterval(timer);
  }, [failed, links]);

  const stage =
    elapsed >= 7
      ? "Прогреваем торрент и собираем манифест…"
      : elapsed >= 3
        ? "Оцениваем релизы и размечаем источники…"
        : "Ищем источники трансляции…";

  const load = React.useCallback(() => {
    setFailed(false);
    api
      .getMediaLinks(item.id, mediaId)
      .then((res) => setLinks(res))
      .catch(() => setFailed(true));
  }, [api, item.id, mediaId]);

  React.useEffect(() => {
    setLinks(null);
    load();
  }, [load]);

  // Предподключение к origin медиа: TCP/TLS-хендшейк стартует, пока React
  // ещё монтирует плеер, — первый сегмент идёт без задержки на соединение.
  React.useEffect(() => {
    if (!links) return;
    const url = links.files[0]?.urls.hls ?? links.files[0]?.urls.http;
    if (!url) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    const add = (rel: string, crossOrigin: boolean) => {
      // Дедуп: компонент монтируется заново при клиентской навигации, а
      // <link> живёт в <head> до перезагрузки — второй раз не добавляем.
      if (document.head.querySelector(`link[data-zal-preconnect="${origin}"][rel="${rel}"]`)) {
        return;
      }
      const link = document.createElement("link");
      link.rel = rel;
      link.href = origin;
      link.dataset.zalPreconnect = origin;
      if (crossOrigin) link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    };
    add("preconnect", true);
    add("dns-prefetch", false);
  }, [links]);

  // Следующая серия: греем media-links, пока играет текущая, — «Следующая
  // серия» открывается мгновенно, без повторного резолва торрента.
  React.useEffect(() => {
    if (!playbackStarted || !next) return;
    const key = `${item.id}:${next.mediaId}`;
    if (prefetchedNext.current === key) return;
    prefetchedNext.current = key;
    void api.getMediaLinks(item.id, next.mediaId).catch(() => {});
  }, [playbackStarted, next, api, item.id]);

  if (failed) {
    return (
      <div
        className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-[var(--radius-card)] bg-black text-white"
        data-testid="watch-links-error"
      >
        <p className="text-sm text-white/80">Не удалось найти источники трансляции</p>
        <button
        type="button"
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-hover"
          onClick={load}
        >
          Повторить поиск
        </button>
      </div>
    );
  }

  if (!links) {
    return (
      <div
        className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] bg-black text-white"
        data-testid="watch-links-loading"
      >          <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <p className="text-sm font-medium text-white/90">{stage}</p>
          <p className="text-xs text-white/50">
            Rutor + TorrServer + TMDb: {elapsed > 0 ? `${elapsed}с` : "до 10 секунд на первый запрос"}
          </p>
      </div>
    );
  }

  return (
    <>
      {/* key по media: при переходе на следующую серию плеер пересоздаётся,
          а не переиспользует состояние автоплея/резюме прошлой серии. */}
      <Player
        key={`${item.id}:${mediaId}`}
        links={links}
        title={item.title}
        next={next}
        onPlaybackStart={() => setPlaybackStarted(true)}
      />

      {/* Панель быстрого запуска во внешнем плеере */}
      {links.files[0]?.urls.http && (
        <section className="mt-6 rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Просмотр во внешнем плеере
              </h3>
              <p className="mt-0.5 text-xs text-muted">
                Если в браузере нет звука (кодек AC3/Dolby) или хотите 4K HDR без
                перекодирования — откройте поток в IINA или VLC:
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`iina://weblink?url=${encodeURIComponent(links.files[0].urls.http)}`}
                className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition hover:bg-accent-hover"
              >
                Открыть в IINA (Mac)
              </a>
              <a
                href={`vlc://${links.files[0].urls.http}`}
                className="rounded-full border border-border bg-surface-elevated px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/10"
              >
                Открыть в VLC
              </a>
              <a
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(
                  `#EXTM3U\n#EXTINF:-1,${item.title}\n${links.files[0].urls.http}`,
                )}`}
                download={`${item.title}.m3u`}
                className="rounded-full border border-border bg-surface-elevated px-4 py-2 text-xs font-semibold text-white/90 transition hover:bg-white/10"
              >
                Скачать M3U
              </a>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
