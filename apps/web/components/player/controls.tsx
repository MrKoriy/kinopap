"use client";

import type { SpriteMetaDto } from "@zal/api-client";
/** Контрол-бар плеера: seek со спрайт-превью, аудио, субтитры со сдвигом, скорость, PiP. */
import * as React from "react";
import { formatDuration } from "@/lib/format";
import { type BufferedSegment, spriteTileScaledFor } from "@/lib/player-logic";
import type { CastState } from "./cast";

export interface TrackOption {
  index: number;
  label: string;
}

/** Серия для меню выбора. `mediaId` — идентификатор маршрута, не позиция. */
export interface EpisodeOption {
  mediaId: number;
  label: string;
  title: string | null;
}

export interface EpisodeGroupOption {
  heading: string;
  episodes: EpisodeOption[];
}

export interface PlayerControlsProps {
  playing: boolean;
  duration: number;
  /**
   * Уже скачанные отрезки в долях длительности (0 — начало, 1 — конец).
   * Пусто — полоса рисуется без серого буфера, как раньше.
   */
  buffered?: BufferedSegment[];
  volume: number;
  muted: boolean;
  playbackRate: number;
  /** readonly: лестница скоростей приезжает из @zal/shared как const-кортеж. */
  speeds: readonly number[];
  shiftMs: number;
  audioTracks: TrackOption[];
  activeAudio: number;
  subtitles: TrackOption[];
  activeSubtitle: number | null;
  qualities?: TrackOption[];
  activeQuality?: number;
  onQuality?(index: number): void;
  /** Серии тайтла. Пусто или одна серия — меню не показываем. */
  episodeGroups?: EpisodeGroupOption[];
  /** mediaId текущей серии: подсветка в списке и стартовый сезон меню. */
  activeEpisode?: number;
  onEpisode?(mediaId: number): void;
  sprites: SpriteMetaDto | null;
  spriteUrl: string | null;
  /** Реакт-нода живого превью (второй <video>) для стримов без спрайта. */
  scrubPreview?: React.ReactNode;
  /** Время под курсором при скраббинге (null — курсор ушёл). */
  onScrubTime?(time: number | null): void;
  isFullscreen: boolean;
  onTogglePlay(): void;
  onSeek(time: number): void;
  onVolume(volume: number): void;
  onRate(rate: number): void;
  onAudio(index: number): void;
  onSubtitle(index: number | null): void;
  onShift(deltaMs: number): void;
  onPip(): void;
  onFullscreen(): void;
  /** Chromecast/AirPlay (useCast); нет — кнопок нет. */
  cast?: Pick<CastState, "castAvailable" | "casting" | "deviceName" | "airplayAvailable" | "toggleCast" | "showAirplay">;
}

/**
 * Текущая позиция воспроизведения. Обновляется ~4 раза в секунду от
 * timeupdate, поэтому живёт в контексте, а не в props: мемоизированное
 * дерево контролов не ререндерится целиком — подписаны только seek-бар
 * и счётчик времени.
 */
export const PlayerTimeContext = React.createContext(0);

export function usePlayerTime(): number {
  return React.useContext(PlayerTimeContext);
}

/** Контекст закрытия меню: MenuItem закрывает, служебные кнопки (сдвиг) — нет. */
const MenuCloseContext = React.createContext<() => void>(() => {});

/**
 * Порог, секунды, ниже которого перемотка не выполняется.
 *
 * Не «мёртвая зона для дрожания руки», а экономия: перемотка на торрент-стриме
 * стоит дорого — gst пересобирает конвейер, и картинка встаёт на несколько
 * секунд. Отпустить ползунок в полутора секундах от текущей позиции значит
 * заплатить эту цену ни за что.
 */
const SEEK_EPSILON_SECONDS = 2;

/** Seek-бар со спрайт-превью. Единственный подписчик 4Гц-потока времени
 * (плюс TimeLabel) — остальное дерево контролов от него изолировано. */
function Seekbar({
  duration,
  buffered,
  sprites,
  spriteUrl,
  scrubPreview,
  onScrubTime,
  onSeek,
}: {
  duration: number;
  buffered?: BufferedSegment[];
  sprites: SpriteMetaDto | null;
  spriteUrl: string | null;
  scrubPreview?: React.ReactNode;
  onScrubTime?(time: number | null): void;
  onSeek(time: number): void;
}) {
  const currentTime = usePlayerTime();

  const barRef = React.useRef<HTMLDivElement | null>(null);
  const [hoverTime, setHoverTime] = React.useState<number | null>(null);
  const [hoverX, setHoverX] = React.useState(0);
  // Позиция под указателем во время перетаскивания. Пока она есть, полоса
  // рисуется по ней, а не по текущему времени: пользователь должен видеть,
  // куда отпустит, ещё до того как отпустил.
  const [dragTime, setDragTime] = React.useState<number | null>(null);

  const dragging = dragTime != null;
  const displayTime = dragTime ?? currentTime;
  const ratio = duration > 0 ? displayTime / duration : 0;

  /** Время под указателем или null, если длительность ещё неизвестна. */
  const timeAt = (clientX: number): number | null => {
    const bar = barRef.current;
    if (!bar || !duration) return null;
    const rect = bar.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return r * duration;
  };

  // Указатель, а не мышь: полоса должна одинаково работать и пальцем. На
  // touch-экране mouse-событий нет вовсе, поэтому превью кадра и позиция под
  // пальцем раньше просто не появлялись — работал один onClick.
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    const t = timeAt(e.clientX);
    if (!bar || t == null) return;
    setHoverTime(t);
    setHoverX(e.clientX - bar.getBoundingClientRect().left);
    onScrubTime?.(t);
    if (dragging) setDragTime(t);
  };

  const onPointerLeave = () => {
    // Во время перетаскивания превью не убираем: с захватом указателя
    // pointerleave приходит, едва курсор уйдёт за полосу, а перетаскивание
    // продолжается — и превью исчезло бы на середине жеста.
    if (dragging) return;
    setHoverTime(null);
    onScrubTime?.(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = timeAt(e.clientX);
    if (t == null) return;
    const bar = e.currentTarget;
    // Захват указателя: без него pointermove перестаёт приходить, стоит увести
    // курсор за пределы полосы, и перетаскивание обрывается на полпути.
    // Проверка на наличие метода — jsdom, в котором идут тесты, его не имеет.
    if (typeof bar.setPointerCapture === "function") {
      bar.setPointerCapture(e.pointerId);
    }
    setDragTime(t);
    setHoverTime(t);
    onScrubTime?.(t);
  };

  const endDrag = (clientX: number, commit: boolean) => {
    setDragTime(null);
    setHoverTime(null);
    onScrubTime?.(null);
    if (!commit) return;
    const t = timeAt(clientX);
    if (t == null) return;
    // Перемотка на торрент-стриме дорога: она рвёт текущую загрузку и заново
    // поднимает gst. Отпустить ползунок там же, где он и был, — не повод
    // платить за это.
    if (Math.abs(t - currentTime) < SEEK_EPSILON_SECONDS) return;
    onSeek(t);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const bar = e.currentTarget;
    if (
      typeof bar.hasPointerCapture === "function" &&
      bar.hasPointerCapture(e.pointerId)
    ) {
      bar.releasePointerCapture(e.pointerId);
    }
    endDrag(e.clientX, true);
  };

  // Жест отменён системой (жест назад, звонок) — перематывать не за что.
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    endDrag(e.clientX, false);
  };

  const tile =
    hoverTime != null && sprites
      ? spriteTileScaledFor(hoverTime, sprites, 192, 108)
      : null;

  return (
    <div
      ref={barRef}
      className="group relative mb-2 h-1.5 cursor-pointer rounded-full bg-white/20"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-testid="seekbar"
    >
      {/* Буфер: что уже скачано. Под полосой прогресса и над фоном, поэтому
          виден только впереди неё — как на YouTube. pointer-events-none
          обязателен: иначе сегменты перехватывают нажатие, и перетаскивание
          срывается ровно там, где буфер есть, то есть почти всегда. */}
      {(buffered ?? []).map((seg) => (
        <div
          key={`${seg.start}-${seg.end}`}
          className="pointer-events-none absolute inset-y-0 bg-white/40"
          style={{
            left: `${seg.start * 100}%`,
            width: `${(seg.end - seg.start) * 100}%`,
          }}
          data-testid="buffer-segment"
          data-start={seg.start}
          data-end={seg.end}
        />
      ))}
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-accent"
        style={{ width: `${ratio * 100}%` }}
        data-testid="seek-progress"
      />
      <div
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 transition group-hover:opacity-100"
        style={{ left: `${ratio * 100}%` }}
      />

      {/* Превью кадра под курсором */}
      {hoverTime != null && (
        <div
          className="pointer-events-none absolute bottom-full mb-3 -translate-x-1/2 rounded-lg border border-border bg-black p-1"
          style={{ left: Math.max(48, Math.min(hoverX, (barRef.current?.clientWidth ?? 0) - 48)) }}
          data-testid="scrub-preview"
        >
          {tile && spriteUrl ? (
            <div
              className="h-[108px] w-[192px] rounded"
              style={{
                backgroundImage: `url(${spriteUrl})`,
                backgroundPosition: tile.backgroundPosition,
                backgroundSize: tile.backgroundSize,
              }}
            />
          ) : scrubPreview ? (
            <div className="h-[108px] w-[192px] overflow-hidden rounded">
              {scrubPreview}
            </div>
          ) : (
            <div className="h-[108px] w-[192px] rounded bg-surface-2" />
          )}
          <p className="mt-1 text-center text-xs text-white">{formatDuration(hoverTime)}</p>
        </div>
      )}
    </div>
  );
}

/** Счётчик времени: второй подписчик 4Гц-потока. */
function TimeLabel({ duration }: { duration: number }) {
  const currentTime = usePlayerTime();
  return (
    <span className="w-28 text-xs tabular-nums text-white/80">
      {formatDuration(currentTime)} / {formatDuration(duration)}
    </span>
  );
}

function Menu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  return (
    <div className="relative">
      <button
          type="button"
        className="rounded-full px-3 py-1.5 text-sm text-white/80 transition hover:bg-white/10 hover:text-white"
        onClick={() => setOpen((o) => !o)}
        data-testid={`menu-${label.toLowerCase()}`}
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute bottom-full right-0 mb-2 min-w-44 rounded-[var(--radius-card)] border border-border bg-surface p-1.5 shadow-lg"
          onMouseLeave={close}
        >
          <MenuCloseContext.Provider value={close}>{children}</MenuCloseContext.Provider>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
  testId?: string;
}) {
  const close = React.useContext(MenuCloseContext);
  return (
    <button
          type="button"
      className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition ${
        active ? "bg-accent text-white" : "text-white/80 hover:bg-white/10"
      }`}
      onClick={() => {
        onClick();
        // Выбор пункта закрывает меню — раньше оно висело, пока мышь не уйдёт.
        close();
      }}
      data-active={active}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

/**
 * Меню выбора серии.
 *
 * Отдельно от `Menu`, потому что список двухуровневый: у сериала бывает и
 * 1600 серий в 9 сезонах, и плоское меню такой длины нечитаемо, а рендер всех
 * пунктов разом заметно тормозит. Поэтому сверху сезоны, снизу — серии
 * выбранного сезона в прокрутке.
 */
function EpisodesMenu({
  groups,
  activeMediaId,
  onPick,
}: {
  groups: EpisodeGroupOption[];
  activeMediaId: number;
  onPick(mediaId: number): void;
}) {
  const [open, setOpen] = React.useState(false);
  // Открываем на сезоне текущей серии, а не на первом: иначе на седьмом сезоне
  // меню каждый раз показывает первый, и до своей серии надо листать заново.
  const activeGroupIdx = Math.max(
    0,
    groups.findIndex((g) => g.episodes.some((e) => e.mediaId === activeMediaId)),
  );
  const [groupIdx, setGroupIdx] = React.useState(activeGroupIdx);

  React.useEffect(() => {
    if (open) setGroupIdx(activeGroupIdx);
  }, [open, activeGroupIdx]);

  const group = groups[groupIdx] ?? groups[0];
  if (!group) return null;

  return (
    <div className="relative">
      <button
        type="button"
        className="rounded-full px-3 py-1.5 text-sm text-white/80 transition hover:bg-white/10 hover:text-white"
        onClick={() => setOpen((o) => !o)}
        data-testid="menu-серии"
      >
        Серии
      </button>
      {open && (
        <div
          className="absolute bottom-full right-0 mb-2 w-72 rounded-[var(--radius-card)] border border-border bg-surface p-1.5 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {groups.length > 1 && (
            <div className="mb-1 flex flex-wrap gap-1 border-b border-border pb-1.5">
              {groups.map((g, i) => (
                <button
                  key={g.heading}
                  type="button"
                  className={`rounded-full px-2.5 py-1 text-xs transition ${
                    i === groupIdx
                      ? "bg-accent text-white"
                      : "text-white/70 hover:bg-white/10"
                  }`}
                  onClick={() => setGroupIdx(i)}
                  data-active={i === groupIdx}
                  data-testid="player-season-tab"
                >
                  {g.heading}
                </button>
              ))}
            </div>
          )}
          <div className="max-h-64 overflow-y-auto">
            {group.episodes.map((e) => (
              <button
                key={e.mediaId}
                type="button"
                // Сериалы бывают по 1600 серий: content-visibility выкидывает
                // кнопки вне вьюпорта из layout/paint, иначе открытое меню
                // монтирует их все разом.
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition [contain-intrinsic-size:auto_40px] [content-visibility:auto] ${
                  e.mediaId === activeMediaId
                    ? "bg-accent text-white"
                    : "text-white/80 hover:bg-white/10"
                }`}
                onClick={() => {
                  // Клик по текущей серии не гоняет маршрут зря — просто закрываем.
                  if (e.mediaId !== activeMediaId) onPick(e.mediaId);
                  setOpen(false);
                }}
                data-active={e.mediaId === activeMediaId}
                data-testid={`player-episode-${e.mediaId}`}
              >
                <span className="tabular-nums text-xs opacity-70">{e.label}</span>
                {e.title && <span className="ml-2">{e.title}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Контрол-бар. Мемоизирован: перерисовывается только на смену состояния
 * (пауз/громкость/меню/смена дорожек), но не на 4Гц-тик timeupdate —
 * позиция въезжает через PlayerTimeContext только в Seekbar и TimeLabel.
 */
export const PlayerControls = React.memo(function PlayerControls(props: PlayerControlsProps) {
  const {
    playing,
    duration,
    volume,
    muted,
    playbackRate,
    speeds,
    shiftMs,
    audioTracks,
    activeAudio,
    subtitles,
    activeSubtitle,
    sprites,
    spriteUrl,
    isFullscreen,
  } = props;

  // У фильма с единственной частью выбирать нечего: меню показываем только
  // когда серий действительно больше одной.
  const episodeCount = (props.episodeGroups ?? []).reduce(
    (n, g) => n + g.episodes.length,
    0,
  );

  return (
    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-4 pb-3 pt-12">
      {/* Seek-бар со спрайт-превью */}
      <Seekbar
        duration={duration}
        buffered={props.buffered}
        sprites={sprites}
        spriteUrl={spriteUrl}
        scrubPreview={props.scrubPreview}
        onScrubTime={props.onScrubTime}
        onSeek={props.onSeek}
      />

      <div className="flex items-center gap-2 text-white">
        <button
          type="button"
          className="rounded-full p-2 transition hover:bg-white/10"
          onClick={props.onTogglePlay}
          aria-label={playing ? "Пауза" : "Играть"}
          data-testid="play-toggle"
        >
          {playing ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5.5v13a1 1 0 0 0 1.5.9l11-6.5a1 1 0 0 0 0-1.7l-11-6.5a1 1 0 0 0-1.5.8Z" />
            </svg>
          )}
        </button>

        <TimeLabel duration={duration} />

        {/* Громкость */}
        <div className="flex items-center gap-1.5">
          <button
          type="button"
            className="rounded-full p-2 hover:bg-white/10"
            onClick={() => props.onVolume(muted || volume === 0 ? 1 : 0)}
            aria-label="Звук"
            data-testid="mute-toggle"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 9v6h4l5 4V5L8 9H4Z" />
              {!(muted || volume === 0) && (
                <path
                  d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  fill="none"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => props.onVolume(Number(e.target.value))}
            className="w-20 accent-[var(--color-accent)]"
            aria-label="Громкость"
            data-testid="volume-slider"
          />
        </div>

        <div className="flex-1" />

        {/* Скорость */}
        <Menu label={`${playbackRate}x`}>
          {speeds.map((s) => (
            <MenuItem key={s} active={s === playbackRate} onClick={() => props.onRate(s)}>
              {s}x
            </MenuItem>
          ))}
        </Menu>

        {/* Серии */}
        {episodeCount > 1 && props.episodeGroups && (
          <EpisodesMenu
            groups={props.episodeGroups}
            activeMediaId={props.activeEpisode ?? -1}
            onPick={(mediaId) => props.onEpisode?.(mediaId)}
          />
        )}

        {/* Качество / Источник */}
        {props.qualities && props.qualities.length > 0 && (
          <Menu label="Качество">
            {props.qualities.map((q) => (
              <MenuItem
                key={q.index}
                active={q.index === (props.activeQuality ?? 0)}
                onClick={() => props.onQuality?.(q.index)}
                testId={`quality-option-${q.index}`}
              >
                {q.label}
              </MenuItem>
            ))}
          </Menu>
        )}

        {/* Аудиодорожки */}
        <Menu label="Аудио">
          {audioTracks.length === 0 && (
            <MenuItem active={false} onClick={() => {}}>
              Дорожек нет
            </MenuItem>
          )}
          {audioTracks.map((t) => (
            <MenuItem
              key={t.index}
              active={t.index === activeAudio}
              onClick={() => props.onAudio(t.index)}
              testId={`audio-option-${t.index}`}
            >
              {t.label}
            </MenuItem>
          ))}
        </Menu>

        {/* Субтитры + сдвиг */}
        <Menu label="Субтитры">
          <MenuItem active={activeSubtitle == null} onClick={() => props.onSubtitle(null)}>
            Выключены
          </MenuItem>
          {subtitles.map((s) => (
            <MenuItem
              key={s.index}
              active={s.index === activeSubtitle}
              onClick={() => props.onSubtitle(s.index)}
            >
              {s.label}
            </MenuItem>
          ))}
          {activeSubtitle != null && (
            <div className="mt-1 flex items-center justify-between border-t border-border px-3 py-2 text-xs text-white/80">
              <button
          type="button"
                className="rounded px-2 py-1 hover:bg-white/10"
                onClick={() => props.onShift(-100)}
                data-testid="shift-minus"
              >
                −0.1s
              </button>
              <span className="tabular-nums" data-testid="shift-value">
                {(shiftMs / 1000).toFixed(1)}s
              </span>
              <button
          type="button"
                className="rounded px-2 py-1 hover:bg-white/10"
                onClick={() => props.onShift(100)}
                data-testid="shift-plus"
              >
                +0.1s
              </button>
            </div>
          )}
        </Menu>

        {props.cast?.castAvailable && (
          <button
            type="button"
            className={`rounded-full p-2 hover:bg-white/10 ${props.cast.casting ? "text-accent" : ""}`}
            onClick={props.cast.toggleCast}
            aria-label={props.cast.casting ? `Остановить трансляцию на ${props.cast.deviceName ?? "телевизор"}` : "Транслировать на телевизор"}
            title={props.cast.casting ? `Идёт на ${props.cast.deviceName ?? "телевизоре"}` : "Chromecast"}
            data-testid="cast"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 17a4 4 0 0 1 4 4M3 13a8 8 0 0 1 8 8M3 9a12 12 0 0 1 12 12" strokeLinecap="round" />
              <path d="M7 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {props.cast?.airplayAvailable && (
          <button
            type="button"
            className="rounded-full p-2 hover:bg-white/10"
            onClick={props.cast.showAirplay}
            aria-label="AirPlay"
            data-testid="airplay"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M6 17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1" strokeLinecap="round" />
              <path d="M12 15l5 6H7z" fill="currentColor" stroke="none" />
            </svg>
          </button>
        )}

        <button
          type="button"
          className="rounded-full p-2 hover:bg-white/10"
          onClick={props.onPip}
          aria-label="Картинка в картинке"
          data-testid="pip"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
          </svg>
        </button>

        <button
          type="button"
          className="rounded-full p-2 hover:bg-white/10"
          onClick={props.onFullscreen}
          aria-label="Полный экран"
          data-testid="fullscreen"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            {isFullscreen ? (
              <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" strokeLinecap="round" />
            ) : (
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>
    </div>
  );
});
