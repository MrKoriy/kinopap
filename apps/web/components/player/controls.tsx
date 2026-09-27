"use client";

/** Контрол-бар плеера: seek со спрайт-превью, аудио, субтитры со сдвигом, скорость, PiP. */
import * as React from "react";
import type { SpriteMetaDto } from "@zal/api-client";
import { spriteTileFor } from "@/lib/player-logic";
import { formatDuration } from "@/lib/format";

export interface TrackOption {
  index: number;
  label: string;
}

export interface PlayerControlsProps {
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  speeds: number[];
  shiftMs: number;
  audioTracks: TrackOption[];
  activeAudio: number;
  subtitles: TrackOption[];
  activeSubtitle: number | null;
  sprites: SpriteMetaDto | null;
  spriteUrl: string | null;
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
}

function Menu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="relative">
      <button
        className="rounded-full px-3 py-1.5 text-sm text-white/80 transition hover:bg-white/10 hover:text-white"
        onClick={() => setOpen((o) => !o)}
        data-testid={`menu-${label.toLowerCase()}`}
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute bottom-full right-0 mb-2 min-w-44 rounded-[var(--radius-card)] border border-border bg-surface p-1.5 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition ${
        active ? "bg-accent text-white" : "text-white/80 hover:bg-white/10"
      }`}
      onClick={() => {
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export function PlayerControls(props: PlayerControlsProps) {
  const {
    playing,
    currentTime,
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

  const barRef = React.useRef<HTMLDivElement | null>(null);
  const [hoverTime, setHoverTime] = React.useState<number | null>(null);
  const [hoverX, setHoverX] = React.useState(0);

  const ratio = duration > 0 ? currentTime / duration : 0;

  const onBarMove = (e: React.MouseEvent) => {
    const bar = barRef.current;
    if (!bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverTime(r * duration);
    setHoverX(e.clientX - rect.left);
  };

  const tile = hoverTime != null && sprites ? spriteTileFor(hoverTime, sprites) : null;

  return (
    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-4 pb-3 pt-12">
      {/* Seek-бар со спрайт-превью */}
      <div
        ref={barRef}
        className="group relative mb-2 h-1.5 cursor-pointer rounded-full bg-white/20"
        onMouseMove={onBarMove}
        onMouseLeave={() => setHoverTime(null)}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const r = (e.clientX - rect.left) / rect.width;
          props.onSeek(r * duration);
        }}
        data-testid="seekbar"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${ratio * 100}%` }}
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
                  backgroundSize: `${sprites!.columns * 192}px ${sprites!.rows * 108}px`,
                }}
              />
            ) : (
              <div className="h-[108px] w-[192px] rounded bg-surface-2" />
            )}
            <p className="mt-1 text-center text-xs text-white">{formatDuration(hoverTime)}</p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-white">
        <button
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

        <span className="w-28 text-xs tabular-nums text-white/80">
          {formatDuration(currentTime)} / {formatDuration(duration)}
        </span>

        {/* Громкость */}
        <div className="flex items-center gap-1.5">
          <button
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
                className="rounded px-2 py-1 hover:bg-white/10"
                onClick={() => props.onShift(100)}
                data-testid="shift-plus"
              >
                +0.1s
              </button>
            </div>
          )}
        </Menu>

        <button
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
}
