'use client';
/**
 * ClipEditor — CPD-278
 *
 * Two modes, driven by productionPath:
 *
 * EXTRACT  (long_produce_source | short_cut_longform)
 *   Customer has one long-form source. They scrub through it, set IN/OUT
 *   timestamps for each clip they want extracted. Features can be uniform
 *   across all clips, or each clip can carry its own override set.
 *
 * COMPACT  (long_compile_clips | short_enhance_upload | short_fetch_enhance)
 *   Customer has N short clips already selected. They define the assembly
 *   order via drag-and-drop and optionally trim each clip's start/end.
 *   Features are mostly uniform for the assembled output; per-clip overrides
 *   are available for dynamic variation within the output.
 *
 * Output via onConfirm(clipSpec):
 *   EXTRACT → { mode:'extract', clips:[{id,startTime,endTime,title}], uniformFeatures, featureOverrides }
 *   COMPACT → { mode:'compact', clips:[{id,url,title,order,trimStart,trimEnd}], uniformFeatures, featureOverrides }
 *
 * Template integration: if a template pre-populates clips, the editor shows
 * them pre-filled so the customer adjusts rather than builds from scratch.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EditorMode = 'extract' | 'compact';

export interface ExtractClip {
  id:               string;
  startTime:        number;   // seconds
  endTime:          number;   // seconds
  title:            string;
  featureOverrides: Record<string, boolean>;
}

export interface CompactClip {
  id:               string;
  url:              string;
  title:            string;
  order:            number;
  trimStart:        number;   // seconds
  trimEnd:          number | null; // null = use full clip duration
  durationHint?:    number;   // seconds, from source library fetch
  thumbnailUrl?:    string;
  featureOverrides: Record<string, boolean>;
}

export interface ClipSpec {
  mode:             EditorMode;
  clips:            (ExtractClip | CompactClip)[];
  uniformFeatures:  boolean;
  featureOverrides: Record<string, Record<string, boolean>>;
}

interface Props {
  mode:              EditorMode;
  sourceUrl?:        string;   // EXTRACT: the long-form video URL
  sourceClips?:      { url: string; title: string; duration?: number; thumbnailUrl?: string }[]; // COMPACT
  availableFeatures: string[]; // feature ids from the wizard's selected features
  onConfirm:         (spec: ClipSpec) => void;
  onCancel:          () => void;
  templateClips?:    Partial<ExtractClip | CompactClip>[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _uid = 0;
function uid() { return `clip-${++_uid}-${Date.now()}`; }

function fmtTime(s: number): string {
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`; // always 2-digit seconds (Gemini: was showing "0:5")
}

function parseTime(v: string): number {
  const parts = v.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(v) || 0;
}

// P1-1: Twitch/Kick/YouTube watch URLs cannot be embedded in a <video> tag.
// Show a platform-specific guidance message instead of a silent broken player.
const UNEMBEDDABLE_PATTERNS = [
  /twitch\.tv/i,
  /kick\.com/i,
  /youtube\.com\/watch/i,
  /youtu\.be\//i,
];

function isUnembeddableUrl(url: string): boolean {
  return UNEMBEDDABLE_PATTERNS.some((p) => p.test(url));
}

function unembeddablePlatformName(url: string): string {
  if (/twitch\.tv/i.test(url))  return 'Twitch Video Producer';
  if (/kick\.com/i.test(url))   return 'Kick VOD manager';
  return 'YouTube Studio';
}

// ─── Feature override row ─────────────────────────────────────────────────────

function FeatureOverrideRow({
  features,
  overrides,
  onChange,
}: {
  features:  string[];
  overrides: Record<string, boolean>;
  onChange:  (k: string, v: boolean) => void;
}) {
  if (!features.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {features.map((f) => {
        const active = overrides[f] ?? true;
        return (
          <button
            key={f}
            type="button"
            onClick={() => onChange(f, !active)}
            className={cn(
              'px-2 py-0.5 text-[10px] rounded border capitalize transition-colors',
              active
                ? 'bg-primary/10 border-primary/40 text-primary'
                : 'border-border text-muted-foreground line-through opacity-50',
            )}
          >
            {f.replace(/_/g, ' ')}
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACT EDITOR
// ═══════════════════════════════════════════════════════════════════════════════

function ExtractEditor({
  sourceUrl,
  clips,
  setClips,
  availableFeatures,
  uniformFeatures,
  setUniformFeatures,
}: {
  sourceUrl?:         string;
  clips:              ExtractClip[];
  setClips:           React.Dispatch<React.SetStateAction<ExtractClip[]>>;
  availableFeatures:  string[];
  uniformFeatures:    boolean;
  setUniformFeatures: (v: boolean) => void;
}) {
  const videoRef                    = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]     = useState(0);
  const [videoOk, setVideoOk]       = useState<boolean | null>(null);
  const [inPoint, setInPoint]       = useState<number | null>(null);
  const [outError, setOutError]     = useState(false);
  const [manualIn, setManualIn]     = useState('');
  const [manualOut, setManualOut]   = useState('');

  const markIn  = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    setInPoint(t);
    setManualIn(fmtTime(t));
  }, []);

  const markOut = useCallback(() => {
    const t     = videoRef.current?.currentTime ?? 0;
    const start = inPoint ?? 0;
    if (t <= start) {
      // P1-3: give visible feedback instead of silent failure
      setOutError(true);
      setTimeout(() => setOutError(false), 600);
      return;
    }
    const newClip: ExtractClip = {
      id:               uid(),
      startTime:        start,
      endTime:          t,
      title:            `Clip ${clips.length + 1} (${fmtTime(start)}–${fmtTime(t)})`,
      featureOverrides: {},
    };
    setClips((prev) => [...prev, newClip]);
    setInPoint(null);
    setManualIn('');
    setManualOut('');
    setOutError(false);
  }, [inPoint, clips.length, setClips]);

  function addManual() {
    const s = parseTime(manualIn);
    const e = parseTime(manualOut);
    if (e <= s) return;
    const newClip: ExtractClip = {
      id:               uid(),
      startTime:        s,
      endTime:          e,
      title:            `Clip ${clips.length + 1} (${fmtTime(s)}–${fmtTime(e)})`,
      featureOverrides: {},
    };
    setClips((prev) => [...prev, newClip]);
    setManualIn('');
    setManualOut('');
    setInPoint(null);
  }

  function removeClip(id: string) {
    setClips((prev) => prev.filter((c) => c.id !== id));
  }

  function updateClip(id: string, patch: Partial<ExtractClip>) {
    setClips((prev) => prev.map((c) => c.id === id ? { ...c, ...patch } : c));
  }

  const seekTo = useCallback((s: number) => {
    if (videoRef.current) videoRef.current.currentTime = s;
  }, []);

  return (
    <div className="space-y-4">
      {/* Video player */}
      <div className="rounded-lg border border-border overflow-hidden bg-black">
        {sourceUrl && isUnembeddableUrl(sourceUrl) ? (
          // P1-1: Twitch/Kick/YouTube links can't play in a browser <video> tag — show guidance
          <div className="px-4 py-5 space-y-1.5">
            <p className="text-sm font-medium text-foreground">
              {unembeddablePlatformName(sourceUrl)} links can&apos;t be previewed here.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Open {unembeddablePlatformName(sourceUrl)} to find the exact timestamps,
              then enter them manually in the fields below.
            </p>
          </div>
        ) : sourceUrl ? (
          <video
            ref={videoRef}
            src={sourceUrl}
            controls
            className="w-full max-h-72 object-contain"
            onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
            onLoadedMetadata={() => {
              setDuration(videoRef.current?.duration ?? 0);
              setVideoOk(true);
            }}
            onError={() => setVideoOk(false)}
          />
        ) : (
          <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
            No video source — enter timestamps manually below
          </div>
        )}
      </div>

      {/* Playback info + mark buttons */}
      {/* P1-1: only show mark buttons when video is actually loaded and playable */}
      {videoOk === true && sourceUrl && !isUnembeddableUrl(sourceUrl) && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs tabular-nums text-muted-foreground font-mono">
            {fmtTime(currentTime)} / {duration > 0 ? fmtTime(duration) : '—'}
          </span>
          <button
            type="button"
            onClick={markIn}
            className={cn(
              'px-3 py-1.5 text-xs rounded-md border font-medium transition-colors',
              inPoint !== null
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {inPoint !== null ? `In: ${fmtTime(inPoint)}` : '▷ Mark In'}
          </button>
          <button
            type="button"
            onClick={markOut}
            disabled={inPoint === null}
            title={outError ? `Out point must be after In (${fmtTime(inPoint ?? 0)})` : undefined}
            className={cn(
              'px-3 py-1.5 text-xs rounded-md border font-medium transition-all disabled:opacity-40',
              outError
                ? 'border-destructive/60 text-destructive'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {/* P1-3: button text changes on failure — no shake animation needed */}
            {outError ? 'Out must be after In' : '▷ Mark Out'}
          </button>
          <span className="text-[10px] text-muted-foreground">or enter timestamps manually →</span>
        </div>
      )}

      {/* Manual timestamp entry */}
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">In point (m:ss)</p>
          <input
            type="text"
            value={manualIn}
            onChange={(e) => setManualIn(e.target.value)}
            placeholder="0:00"
            className="w-24 h-8 px-2 text-sm font-mono rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Out point (m:ss)</p>
          <input
            type="text"
            value={manualOut}
            onChange={(e) => setManualOut(e.target.value)}
            placeholder="0:30"
            className="w-24 h-8 px-2 text-sm font-mono rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <button
          type="button"
          onClick={addManual}
          disabled={!manualIn || !manualOut}
          className="h-8 px-3 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
        >
          + Add clip
        </button>
      </div>

      {/* Clip list */}
      {clips.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-foreground">{clips.length} clip{clips.length > 1 ? 's' : ''} marked</p>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <span>Uniform features</span>
              <button
                type="button"
                onClick={() => setUniformFeatures(!uniformFeatures)}
                className={cn(
                  'relative w-8 h-4 rounded-full border transition-colors',
                  uniformFeatures ? 'bg-primary border-primary' : 'border-border bg-muted',
                )}
              >
                <span className={cn(
                  'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform',
                  uniformFeatures ? 'translate-x-4' : 'translate-x-0.5',
                )} />
              </button>
            </label>
          </div>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {clips.map((clip, i) => (
              <div key={clip.id} className="rounded-lg border border-border bg-card p-3 space-y-2">
                <div className="flex items-start gap-2">
                  {/* Seek button */}
                  {videoOk && (
                    <button
                      type="button"
                      onClick={() => seekTo(clip.startTime)}
                      title="Seek to clip start"
                      className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </button>
                  )}
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={clip.title}
                      onChange={(e) => updateClip(clip.id, { title: e.target.value })}
                      className="w-full text-sm font-medium bg-transparent border-0 p-0 focus:outline-none text-foreground"
                      placeholder={`Clip ${i + 1}`}
                    />
                    <div className="flex items-center gap-3 mt-1">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span className="text-[10px] uppercase tracking-wide opacity-60">in</span>
                        <input
                          type="text"
                          value={fmtTime(clip.startTime)}
                          onChange={(e) => updateClip(clip.id, { startTime: parseTime(e.target.value) })}
                          className="w-14 h-6 px-1 font-mono text-xs rounded border border-input bg-background text-center focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <span className="text-[10px] uppercase tracking-wide opacity-60">out</span>
                        <input
                          type="text"
                          value={fmtTime(clip.endTime)}
                          onChange={(e) => updateClip(clip.id, { endTime: parseTime(e.target.value) })}
                          className="w-14 h-6 px-1 font-mono text-xs rounded border border-input bg-background text-center focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <span className="text-muted-foreground/60">
                          {fmtTime(clip.endTime - clip.startTime)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeClip(clip.id)}
                    className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                {/* Per-clip feature overrides when not uniform */}
                {!uniformFeatures && availableFeatures.length > 0 && (
                  <div>
                    <p className="text-[10px] text-muted-foreground mb-1">Features for this clip:</p>
                    <FeatureOverrideRow
                      features={availableFeatures}
                      overrides={clip.featureOverrides}
                      onChange={(k, v) => updateClip(clip.id, {
                        featureOverrides: { ...clip.featureOverrides, [k]: v },
                      })}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {clips.length === 0 && (
        <p className="text-xs text-muted-foreground bg-muted/30 rounded-lg px-4 py-3 text-center">
          Mark at least one clip to continue — or let AuraFlux decide by toggling off the editor above.
        </p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPACT EDITOR — sortable clip row
// ═══════════════════════════════════════════════════════════════════════════════

function SortableClipRow({
  clip,
  index,
  availableFeatures,
  uniformFeatures,
  onChange,
  onRemove,
}: {
  clip:              CompactClip;
  index:             number;
  availableFeatures: string[];
  uniformFeatures:   boolean;
  onChange:          (patch: Partial<CompactClip>) => void;
  onRemove:          () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: clip.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const max = clip.durationHint ?? 600;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-lg border border-border bg-card p-3 space-y-2.5',
        isDragging && 'ring-1 ring-primary shadow-lg',
      )}
    >
      <div className="flex items-start gap-2.5">
        {/* Drag handle */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="mt-1 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground transition-colors touch-none"
          aria-label="Drag to reorder"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
          </svg>
        </button>

        {/* Thumbnail */}
        {clip.thumbnailUrl && (
          <div className="shrink-0 w-16 h-10 rounded overflow-hidden bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={clip.thumbnailUrl} alt="" className="w-full h-full object-cover" />
          </div>
        )}

        {/* Title + order badge */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground/60 bg-muted px-1.5 py-0.5 rounded shrink-0">
              {String(index + 1).padStart(2, '0')}
            </span>
            <input
              type="text"
              value={clip.title}
              onChange={(e) => onChange({ title: e.target.value })}
              className="flex-1 text-sm font-medium bg-transparent border-0 p-0 focus:outline-none text-foreground truncate"
              placeholder={`Clip ${index + 1}`}
            />
          </div>

          {/* Trim range */}
          <div className="mt-2 space-y-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="text-[10px] uppercase tracking-wide opacity-60 w-5 shrink-0">in</span>
              <input
                type="range"
                min={0}
                max={max}
                step={1}
                value={clip.trimStart}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v < (clip.trimEnd ?? max)) onChange({ trimStart: v });
                }}
                className="flex-1 h-1.5 accent-primary cursor-pointer"
              />
              <span className="font-mono text-[10px] w-10 text-right shrink-0">{fmtTime(clip.trimStart)}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="text-[10px] uppercase tracking-wide opacity-60 w-5 shrink-0">out</span>
              <input
                type="range"
                min={0}
                max={max}
                step={1}
                value={clip.trimEnd ?? max}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v > clip.trimStart) onChange({ trimEnd: v === max ? null : v });
                }}
                className="flex-1 h-1.5 accent-primary cursor-pointer"
              />
              <span className="font-mono text-[10px] w-10 text-right shrink-0">
                {clip.trimEnd !== null ? fmtTime(clip.trimEnd) : 'end'}
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Per-clip feature overrides */}
      {!uniformFeatures && availableFeatures.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">Features for this clip:</p>
          <FeatureOverrideRow
            features={availableFeatures}
            overrides={clip.featureOverrides}
            onChange={(k, v) => onChange({ featureOverrides: { ...clip.featureOverrides, [k]: v } })}
          />
        </div>
      )}
    </div>
  );
}

function CompactEditor({
  sourceClips,
  clips,
  setClips,
  availableFeatures,
  uniformFeatures,
  setUniformFeatures,
}: {
  sourceClips?:       { url: string; title: string; duration?: number; thumbnailUrl?: string }[];
  clips:              CompactClip[];
  setClips:           React.Dispatch<React.SetStateAction<CompactClip[]>>;
  availableFeatures:  string[];
  uniformFeatures:    boolean;
  setUniformFeatures: (v: boolean) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Seed clips from sourceClips on mount or when sourceClips first arrives
  useEffect(() => {
    if (clips.length === 0 && sourceClips && sourceClips.length > 0) {
      setClips(
        sourceClips.map((s, i) => ({
          id:               uid(),
          url:              s.url,
          title:            s.title || `Clip ${i + 1}`,
          order:            i,
          trimStart:        0,
          trimEnd:          null,
          durationHint:     s.duration,
          thumbnailUrl:     s.thumbnailUrl,
          featureOverrides: {},
        })),
      );
    }
  // sourceClips is the dependency — re-seed if the prop arrives after mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceClips]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setClips((prev) => {
      const oldIdx = prev.findIndex((c) => c.id === active.id);
      const newIdx = prev.findIndex((c) => c.id === over.id);
      return arrayMove(prev, oldIdx, newIdx).map((c, i) => ({ ...c, order: i }));
    });
  }

  function updateClip(id: string, patch: Partial<CompactClip>) {
    setClips((prev) => prev.map((c) => c.id === id ? { ...c, ...patch } : c));
  }

  return (
    <div className="space-y-4">
      {/* Header + uniform toggle */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Drag to set the clip order. Use In/Out sliders to trim each clip.
        </p>
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none shrink-0">
          <span>Uniform features</span>
          <button
            type="button"
            onClick={() => setUniformFeatures(!uniformFeatures)}
            className={cn(
              'relative w-8 h-4 rounded-full border transition-colors',
              uniformFeatures ? 'bg-primary border-primary' : 'border-border bg-muted',
            )}
          >
            <span className={cn(
              'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform',
              uniformFeatures ? 'translate-x-4' : 'translate-x-0.5',
            )} />
          </button>
        </label>
      </div>

      {clips.length === 0 ? (
        <p className="text-xs text-muted-foreground bg-muted/30 rounded-lg px-4 py-3 text-center">
          No clips to arrange — source clips will appear here once selected.
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={clips.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
              {clips.map((clip, i) => (
                <SortableClipRow
                  key={clip.id}
                  clip={clip}
                  index={i}
                  availableFeatures={availableFeatures}
                  uniformFeatures={uniformFeatures}
                  onChange={(patch) => updateClip(clip.id, patch)}
                  onRemove={() => setClips((prev) => prev.filter((c) => c.id !== clip.id).map((c, j) => ({ ...c, order: j })))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Assembly order summary strip */}
      {clips.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {clips.map((c, i) => (
            <div key={c.id} className="flex items-center gap-1">
              {/* P1-2: show actual title (truncated), not just first word */}
              <span className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono truncate max-w-[96px]" title={c.title}>
                {i + 1}. {c.title.length > 12 ? `${c.title.slice(0, 12)}…` : c.title}
              </span>
              {i < clips.length - 1 && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground/40 shrink-0">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIP EDITOR — main export
// ═══════════════════════════════════════════════════════════════════════════════

export function ClipEditor({ mode, sourceUrl, sourceClips, availableFeatures, onConfirm, onCancel, templateClips }: Props) {
  const [extractClips, setExtractClips] = useState<ExtractClip[]>(
    (templateClips ?? []).filter((c): c is ExtractClip => 'startTime' in c),
  );
  const [compactClips, setCompactClips] = useState<CompactClip[]>(
    (templateClips ?? []).filter((c): c is CompactClip => 'order' in c),
  );
  const [uniformFeatures, setUniformFeatures] = useState(true);

  const clips = mode === 'extract' ? extractClips : compactClips;
  const canConfirm = clips.length > 0;

  function handleConfirm() {
    const featureOverrides: Record<string, Record<string, boolean>> = {};
    if (!uniformFeatures) {
      clips.forEach((c) => {
        if (Object.keys(c.featureOverrides).length) {
          featureOverrides[c.id] = c.featureOverrides;
        }
      });
    }
    onConfirm({
      mode,
      clips,
      uniformFeatures,
      featureOverrides,
    });
  }

  return (
    <div className="space-y-4">
      {/* Mode header */}
      <div className="flex items-center gap-2.5">
        <div className={cn(
          'w-1.5 h-6 rounded-full shrink-0',
          mode === 'extract' ? 'bg-amber-500' : 'bg-blue-500',
        )} />
        <div>
          <p className="text-sm font-medium text-foreground">
            {mode === 'extract' ? 'Mark extraction points' : 'Arrange clips'}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {mode === 'extract'
              ? 'Set in/out timestamps — each range becomes one extracted short-form clip'
              : 'Set the clip order and trim each clip — uniform features apply to all, or override per clip'}
          </p>
        </div>
      </div>

      {/* Editor body */}
      {mode === 'extract' ? (
        <ExtractEditor
          sourceUrl={sourceUrl}
          clips={extractClips}
          setClips={setExtractClips}
          availableFeatures={availableFeatures}
          uniformFeatures={uniformFeatures}
          setUniformFeatures={setUniformFeatures}
        />
      ) : (
        <CompactEditor
          sourceClips={sourceClips}
          clips={compactClips}
          setClips={setCompactClips}
          availableFeatures={availableFeatures}
          uniformFeatures={uniformFeatures}
          setUniformFeatures={setUniformFeatures}
        />
      )}

      {/* Uniform features display */}
      {uniformFeatures && availableFeatures.length > 0 && (
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">Applying to all clips</p>
          <div className="flex flex-wrap gap-1.5">
            {availableFeatures.map((f) => (
              <span key={f} className="px-2 py-0.5 text-[10px] rounded bg-primary/10 border border-primary/30 text-primary capitalize">
                {f.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!canConfirm}
          className={cn(
            'flex-1 h-9 text-sm rounded-md border font-medium transition-colors',
            canConfirm
              ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90'
              : 'border-border text-muted-foreground cursor-not-allowed opacity-50',
          )}
        >
          {canConfirm
            ? `Confirm ${clips.length} clip${clips.length > 1 ? 's' : ''}`
            : mode === 'extract' ? 'Mark at least one clip' : 'No clips to arrange'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 h-9 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
        >
          Let AuraFlux decide
        </button>
      </div>
    </div>
  );
}
