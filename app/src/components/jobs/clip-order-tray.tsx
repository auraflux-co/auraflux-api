'use client';
/**
 * ClipOrderTray — Horizontal strip showing selected clips in stitch order.
 *
 * Renders when 2+ clips are selected in multi-clip mode.
 * Each card shows: position number, thumbnail, title, duration.
 * ← → arrow buttons reorder clips; the parent receives the updated array via onReorder.
 *
 * Usage:
 *   <ClipOrderTray items={selectedItems} onReorder={setSelectedItems} />
 */

import { useRef } from 'react';
import { cn } from '@/lib/utils';
import type { SourceItem } from '@/lib/api';

function formatDuration(s: number): string {
  if (!s) return '';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatTotal(items: SourceItem[]): string {
  const total = items.reduce((s, i) => s + (i.duration ?? 0), 0);
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (h > 0) return `${h}h ${m}m total`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s total`;
  return `${s}s total`;
}

// Map platform string to a colour used when no thumbnail is available
const PLATFORM_COLOURS: Record<string, string> = {
  twitch:    '#6441a5',
  kick:      '#1a7a2a',
  youtube:   '#c00',
  instagram: '#8a3ab9',
  tiktok:    '#010101',
};

interface Props {
  items:      SourceItem[];
  onReorder:  (items: SourceItem[]) => void;
  onRemove?:  (url: string) => void;
  className?: string;
}

export function ClipOrderTray({ items, onReorder, onRemove, className }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  if (items.length === 0) return null;

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...items];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    onReorder(next);
    // Scroll the moved card into view
    requestAnimationFrame(() => {
      const card = scrollRef.current?.children[swap] as HTMLElement | undefined;
      card?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    });
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between px-0.5">
        <p className="text-xs font-semibold text-foreground">
          Clip order
          {items.length > 1 && (
            <span className="ml-1 font-normal text-muted-foreground">
              — drag arrows to reorder before submitting
            </span>
          )}
        </p>
        {formatTotal(items) && (
          <span className="text-[11px] text-muted-foreground font-medium tabular-nums">
            {formatTotal(items)}
          </span>
        )}
      </div>

      {/* Horizontal scroll strip */}
      <div
        ref={scrollRef}
        className="flex gap-3 overflow-x-auto pb-2 scroll-smooth"
        style={{ scrollbarWidth: 'thin' }}
      >
        {items.map((item, idx) => {
          const colour = PLATFORM_COLOURS[item.platform ?? ''] ?? '#334155';
          return (
            <div
              key={item.url}
              className="flex-shrink-0 w-44 rounded-xl border border-border/60 bg-card overflow-hidden shadow-sm"
            >
              {/* Thumbnail */}
              <div className="relative h-24 bg-muted overflow-hidden">
                {item.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.thumbnailUrl}
                    alt={item.title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full" style={{ background: colour }} />
                )}

                {/* Position badge */}
                <div className="absolute top-1.5 left-1.5 w-6 h-6 rounded-full bg-black/70 text-white text-xs font-bold flex items-center justify-center">
                  {idx + 1}
                </div>

                {/* Duration badge */}
                {(item.duration ?? 0) > 0 && (
                  <span className="absolute bottom-1.5 right-1.5 bg-black/80 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
                    {formatDuration(item.duration!)}
                  </span>
                )}
              </div>

              {/* Title + controls */}
              <div className="p-2 space-y-1.5">
                <p className="text-[11px] font-medium text-foreground line-clamp-2 leading-snug">
                  {item.title}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    aria-label="Move left"
                    className="flex-1 h-6 text-xs rounded-md border border-border/60 bg-muted/50 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, 1)}
                    disabled={idx === items.length - 1}
                    aria-label="Move right"
                    className="flex-1 h-6 text-xs rounded-md border border-border/60 bg-muted/50 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    →
                  </button>
                  {onRemove && (
                    <button
                      type="button"
                      onClick={() => onRemove(item.url)}
                      aria-label="Remove clip"
                      className="h-6 w-6 text-xs rounded-md border border-border/60 text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {items.length > 1 && (
        <p className="text-[10px] text-muted-foreground px-0.5">
          Clips are stitched together in this exact order during assembly.
        </p>
      )}
    </div>
  );
}
