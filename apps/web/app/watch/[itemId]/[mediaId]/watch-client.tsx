"use client";

import type { ItemDetail, MediaLinks } from "@zal/api-client";
/**
 * Клиентская часть watch-страницы: подтягивает media-links после рендера.
 * Zero-storage резолв может ходить в rutor/TMDb до ~10 секунд — раньше
 * SSR страницы блокировался на этот срок («страница грузится вечно»).
 * Теперь страница рисуется сразу, источники ищутся под спиннером.
 */
import * as React from "react";
import { LoadingStages } from "@/components/player/loading-stages";
import { Player } from "@/components/player/player";
import { useAuth } from "@/lib/auth";
import {
  absoluteStreamUrl,
  externalPlayerLinks,
  nextEpisode,
  type PlayerEpisodeGroup,
} from "@/lib/player-logic";

export function WatchClient({
  item,
  mediaId,
  episodeGroups,
}: {
  item: ItemDetail;
  mediaId: number;
  /** Серии тайтла для меню в плеере; пусто у фильма. */
  episodeGroups: PlayerEpisodeGroup[];
}) {
  // ready: сессия восстановлена (refresh по cookie завершён). Без ожидания
  // media-links уходил без токена, ловил 401 и запускал второй refresh
  // параллельно с AuthProvider — ротация одного и того же refresh-токена.
  const { api, ready } = useAuth();
  const [links, setLinks] = React.useState<MediaLinks | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [playbackStarted, setPlaybackStarted] = React.useState(false);
  // Растёт после жалобы на раздачу: плеер пересоздаётся с новым набором.
  const [reportEpoch, setReportEpoch] = React.useState(0);
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

  const timedOut = elapsed >= 45;
  const stage = timedOut
    ? "Поиск затянулся — торренты не отвечают"
    : elapsed >= 7
      ? "Прогреваем торрент и собираем манифест…"
      : elapsed >= 3
        ? "Оцениваем релизы и размечаем источники…"
        : "Проверяем готовые раздачи…";

  const abortRef = React.useRef<AbortController | null>(null);
  const load = React.useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setFailed(false);
    api
      .getMediaLinks(item.id, mediaId)
      .then((res) => {
        if (ac.signal.aborted) return;
        setLinks(res);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setFailed(true);
      });
  }, [api, item.id, mediaId]);

  React.useEffect(() => {
    if (!ready) return;
    setLinks(null);
    load();
    return () => abortRef.current?.abort();
  }, [load, ready]);

  // Предподключение к origin медиа — удаляем при размонтаже, чтобы
  // не копить мусор в <head> при навигации watch→item→watch.
  React.useEffect(() => {
    if (!links) return;
    const raw = links.files[0]?.urls.hls ?? links.files[0]?.urls.http;
    if (!raw) return;
    let origin: string;
    try {
      origin = new URL(raw, window.location.origin).origin;
    } catch {
      return;
    }
    if (origin === window.location.origin) return;
    const created: HTMLLinkElement[] = [];
    const add = (rel: string, crossOrigin: boolean) => {
      if (document.head.querySelector(`link[data-zal-preconnect="${origin}"][rel="${rel}"]`)) {
        return;
      }
      const link = document.createElement("link");
      link.rel = rel;
      link.href = origin;
      link.dataset.zalPreconnect = origin;
      if (crossOrigin) link.crossOrigin = "anonymous";
      document.head.appendChild(link);
      created.push(link);
    };
    add("preconnect", true);
    add("dns-prefetch", false);
    return () => {
      for (const el of created) el.remove();
    };
  }, [links]);

  // Следующая серия — из того же списка, что уходит в меню плеера.
  const next = React.useMemo(
    () => nextEpisode(episodeGroups, mediaId),
    [episodeGroups, mediaId],
  );

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
      >
        <LoadingStages stage="search" />
        <p className="text-sm font-medium text-white/90">{stage}</p>
        <p className="text-xs text-white/50">
          {timedOut
            ? "Попробуйте другой релиз или обновите страницу"
            : `Rutor + TorrServer + TMDb: ${elapsed > 0 ? `${elapsed}с` : "до 10 секунд на первый запрос"}`}
        </p>
        <div className="h-1 w-48 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-accent transition-all duration-500"
            style={{ width: `${Math.min(100, (elapsed / 45) * 100)}%` }}
            data-testid="watch-progress"
          />
        </div>
        {timedOut && (
          <button
            type="button"
            className="mt-1 rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-white"
            onClick={load}
            data-testid="watch-retry"
          >
            Повторить
          </button>
        )}
      </div>
    );
  }

  // Ссылки на потоки приходят относительными (/gst/..., /stream?...), чтобы один
  // билд работал и по http://<ip>, и по https://<имя>. Внешним плеерам и M3U
  // нужен полный адрес — с относительным кнопка открыла бы пустоту.
  const externalStreamUrl = absoluteStreamUrl(links.files[0]?.urls.http);

  return (
    <>
      {/* key по media: при переходе на следующую серию плеер пересоздаётся,
          а не переиспользует состояние автоплея/резюме прошлой серии. */}
      <Player
        key={`${item.id}:${mediaId}:${reportEpoch}`}
        links={links}
        title={item.title}
        episodeGroups={episodeGroups}
        currentMediaId={mediaId}
        onPlaybackStart={() => setPlaybackStarted(true)}
        onSourceReported={() => {
          // Раздача забанена для этой серии — сервер уже сбросил кэши пары,
          // свежий запрос отдаст другую. Этапы загрузки покажутся заново.
          setReportEpoch((n) => n + 1);
          setLinks(null);
          setElapsed(0);
          load();
        }}
      />

      {/* Панель быстрого запуска во внешнем плеере */}
      {externalStreamUrl && (
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
                href={externalPlayerLinks(externalStreamUrl).iina}
                className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition hover:bg-accent-hover"
              >
                Открыть в IINA (Mac)
              </a>
              <a
                href={externalPlayerLinks(externalStreamUrl).vlc}
                className="rounded-full border border-border bg-surface-elevated px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/10"
              >
                Открыть в VLC
              </a>
              <a
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(
                  `#EXTM3U\n#EXTINF:-1,${item.title}\n${externalStreamUrl}`,
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
