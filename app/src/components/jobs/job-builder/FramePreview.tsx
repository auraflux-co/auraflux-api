'use client';

import { cn } from '@/lib/utils';
import type { SourceItem } from '@/lib/api';

type Grade = 'none' | 'warm' | 'cool' | 'neut';

interface Props {
  clips:     SourceItem[];
  format:    string;
  captions:  boolean;
  grade:     Grade;
  effects:   string[];
  className?: string;
}

/**
 * Live aspect-ratio frame preview for the job builder sticky panel (CPD-443).
 * Shows first selected clip's thumbnail, grade tint, caption bar, and effects badge.
 */
export function FramePreview({ clips, format, captions, grade, effects, className }: Props) {
  const isPortrait = format === 'portrait';
  const isSquare   = format === 'square';

  const W = isPortrait ? 108 : 192;
  const H = isPortrait ? 192 : isSquare ? 192 : 108;

  const clip = clips[0] ?? null;
  const thumbUrl = clip?.thumbnailUrl ?? null;

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Output preview</p>

      <div
        className="relative overflow-hidden rounded border border-border/60 bg-muted transition-all duration-200 shrink-0"
        style={{ width: W, height: H }}
      >
        {/* Thumbnail or placeholder */}
        {thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[10px] text-muted-foreground">Pick a clip</p>
          </div>
        )}

        {/* Grade overlay */}
        {grade === 'warm' && <div className="absolute inset-0 bg-orange-500/10 mix-blend-multiply pointer-events-none" />}
        {grade === 'cool' && <div className="absolute inset-0 bg-blue-500/12 mix-blend-multiply pointer-events-none" />}

        {/* Effects badge */}
        {effects.length > 0 && (
          <div className="absolute top-1.5 left-1.5 bg-black/60 rounded px-1.5 py-0.5 text-[9px] text-white font-medium">
            {effects.includes('zoom') ? 'ZOOM' : effects[0].toUpperCase()}
          </div>
        )}

        {/* Caption bar */}
        {captions && (
          <div className="absolute bottom-0 left-0 right-0 bg-black/75 px-1.5 py-1 text-[8px] text-white text-center leading-tight">
            Auto-generated captions
          </div>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        {isPortrait ? '9:16' : isSquare ? '1:1' : '16:9'}
        {clips.length > 1 ? ` · ${clips.length} clips` : clip ? '' : ''}
      </p>
    </div>
  );
}
