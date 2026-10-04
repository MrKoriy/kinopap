/**
 * Chromecast (Google Cast Web Sender) и AirPlay для плеера.
 *
 * Cast SDK (~60 КБ) грузится только в Chrome и только когда плеер открыт.
 * На телевизор уходит абсолютная ссылка текущего потока (подписанная /gst-s
 * или /stream TorrServer) — ресивер тянет её сам, без нашего браузера.
 * Default Media Receiver играет MP4/HLS (H.264/AAC); MKV с HEVC/AC3
 * телевизор может не осилить — тогда кнопка «Не играет» в плеере.
 * AirPlay — нативный выбор устройства Safari (webkitShowPlaybackTargetPicker).
 */
import * as React from "react";

interface CastSessionLike {
  loadMedia(req: unknown): Promise<unknown>;
  getCastDevice(): { friendlyName: string };
}
interface CastContextLike {
  setOptions(o: Record<string, unknown>): void;
  addEventListener(type: string, cb: (e: { castState?: string; sessionState?: string }) => void): void;
  requestSession(): Promise<unknown>;
  getCurrentSession(): CastSessionLike | null;
  endCurrentSession(stop: boolean): void;
  getCastState(): string;
}
interface CastGlobals {
  cast?: {
    framework: {
      CastContext: { getInstance(): CastContextLike };
      CastContextEventType: { CAST_STATE_CHANGED: string; SESSION_STATE_CHANGED: string };
      CastState: { NO_DEVICES_AVAILABLE: string; CONNECTED: string };
    };
  };
  chrome?: {
    cast?: {
      AutoJoinPolicy: { ORIGIN_SCOPED: string };
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: string;
        MediaInfo: new (url: string, type: string) => Record<string, unknown>;
        GenericMediaMetadata: new () => Record<string, unknown>;
        LoadRequest: new (info: unknown) => Record<string, unknown>;
      };
      Image: new (url: string) => unknown;
    };
  };
  __onGCastApiAvailable?: (ok: boolean) => void;
}

const SDK = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
let sdkPromise: Promise<boolean> | null = null;

function loadCastSdk(): Promise<boolean> {
  if (sdkPromise) return sdkPromise;
  const w = window as unknown as CastGlobals;
  // Cast SDK работает только в Chromium-браузерах (window.chrome).
  if (!("chrome" in window) || !/Chrome\//.test(navigator.userAgent)) {
    sdkPromise = Promise.resolve(false);
    return sdkPromise;
  }
  sdkPromise = new Promise((resolve) => {
    w.__onGCastApiAvailable = (ok) => resolve(ok && !!w.cast?.framework);
    const s = document.createElement("script");
    s.src = SDK;
    s.async = true;
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
    window.setTimeout(() => resolve(false), 15_000);
  });
  return sdkPromise;
}

/** Тип потока для ресивера по ссылке. */
export function castContentType(url: string): string {
  if (/\.m3u8(\?|$)|\/hls\//i.test(url)) return "application/x-mpegURL";
  if (/\.webm(\?|$)/i.test(url)) return "video/webm";
  return "video/mp4";
}

export interface CastState {
  /** Есть устройства Chromecast в сети. */
  castAvailable: boolean;
  casting: boolean;
  deviceName: string | null;
  airplayAvailable: boolean;
  toggleCast(): void;
  showAirplay(): void;
}

export function useCast(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  media: { url: string; title: string; poster?: string | null },
): CastState {
  const [castAvailable, setCastAvailable] = React.useState(false);
  const [casting, setCasting] = React.useState(false);
  const [deviceName, setDeviceName] = React.useState<string | null>(null);
  const [airplayAvailable, setAirplayAvailable] = React.useState(false);
  const ctxRef = React.useRef<CastContextLike | null>(null);
  const mediaRef = React.useRef(media);
  mediaRef.current = media;

  React.useEffect(() => {
    let cancelled = false;
    void loadCastSdk().then((ok) => {
      const w = window as unknown as CastGlobals;
      if (!ok || cancelled || !w.cast || !w.chrome?.cast) return;
      const fw = w.cast.framework;
      const ctx = fw.CastContext.getInstance();
      ctx.setOptions({
        receiverApplicationId: w.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: w.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      ctxRef.current = ctx;
      const sync = () => {
        const state = ctx.getCastState();
        setCastAvailable(state !== fw.CastState.NO_DEVICES_AVAILABLE);
        const connected = state === fw.CastState.CONNECTED;
        setCasting(connected);
        setDeviceName(connected ? (ctx.getCurrentSession()?.getCastDevice().friendlyName ?? null) : null);
      };
      ctx.addEventListener(fw.CastContextEventType.CAST_STATE_CHANGED, sync);
      sync();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // AirPlay: Safari сообщает о доступных устройствах событием на <video>.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v || !("WebKitPlaybackTargetAvailabilityEvent" in window)) return;
    const onAvail = (e: Event) => setAirplayAvailable((e as Event & { availability?: string }).availability === "available");
    v.addEventListener("webkitplaybacktargetavailabilitychanged", onAvail);
    return () => v.removeEventListener("webkitplaybacktargetavailabilitychanged", onAvail);
  }, [videoRef]);

  const toggleCast = React.useCallback(() => {
    const ctx = ctxRef.current;
    const w = window as unknown as CastGlobals;
    const cc = w.chrome?.cast;
    if (!ctx || !cc) return;
    if (ctx.getCurrentSession()) {
      ctx.endCurrentSession(true);
      return;
    }
    void ctx
      .requestSession()
      .then(async () => {
        const session = ctx.getCurrentSession();
        const m = mediaRef.current;
        if (!session || !m.url) return;
        const info = new cc.media.MediaInfo(m.url, castContentType(m.url));
        const meta = new cc.media.GenericMediaMetadata();
        meta.title = m.title;
        if (m.poster) meta.images = [new cc.Image(new URL(m.poster, window.location.origin).toString())];
        info.metadata = meta;
        const req = new cc.media.LoadRequest(info);
        const video = videoRef.current;
        req.currentTime = video?.currentTime ?? 0;
        req.autoplay = true;
        await session.loadMedia(req);
        video?.pause();
      })
      .catch(() => {
        // пользователь закрыл диалог выбора устройства — не ошибка
      });
  }, [videoRef]);

  const showAirplay = React.useCallback(() => {
    const v = videoRef.current as (HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }) | null;
    v?.webkitShowPlaybackTargetPicker?.();
  }, [videoRef]);

  return { castAvailable, casting, deviceName, airplayAvailable, toggleCast, showAirplay };
}
