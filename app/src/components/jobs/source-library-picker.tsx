'use client';
/**
 * SourceLibraryPicker — Creator Source Library (CPD-274)
 *
 * Renders three branded platform tiles (Twitch / Kick / YouTube).
 * User enters their channel username, browses clips/VODs, and selects
 * content to source for the current job. Selected clip URLs are passed
 * back to the parent via onSelect().
 */

import { useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { fetchSourceContent, type SourcePlatform, type SourceItem } from '@/lib/api';

// ─── Platform config ──────────────────────────────────────────────────────────

const PLATFORMS: {
  id:          SourcePlatform;
  label:       string;
  placeholder: string;
  accent:      string;
  border:      string;
  bg:          string;
  dot:         string;
  icon:        React.ReactNode;
}[] = [
  {
    id:          'twitch',
    label:       'Twitch',
    placeholder: 'e.g. hasanabi',
    accent:      'text-purple-400',
    border:      'border-purple-500/40 hover:border-purple-500/70',
    bg:          'bg-purple-500/8',
    dot:         'bg-purple-500',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-purple-400 shrink-0">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
      </svg>
    ),
  },
  {
    id:          'kick',
    label:       'Kick',
    placeholder: 'e.g. n3on',
    accent:      'text-green-400',
    border:      'border-green-500/40 hover:border-green-500/70',
    bg:          'bg-green-500/8',
    dot:         'bg-green-500',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-green-400 shrink-0">
        <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm-1 14H9V8h2v8zm5-4l-4 4V8l4 4z"/>
      </svg>
    ),
  },
  {
    id:          'youtube',
    label:       'YouTube',
    placeholder: 'e.g. @LazarBeam',
    accent:      'text-red-400',
    border:      'border-red-500/40 hover:border-red-500/70',
    bg:          'bg-red-500/8',
    dot:         'bg-red-500',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-red-400 shrink-0">
        <path d="M23.495 6.205a3.007 3.007 0 0 0-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 0 0 .527 6.205a31.247 31.247 0 0 0-.522 5.805 31.247 31.247 0 0 0 .522 5.783 3.007 3.007 0 0 0 2.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 0 0 2.088-2.088 31.247 31.247 0 0 0 .5-5.783 31.247 31.247 0 0 0-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/>
      </svg>
    ),
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(s: number): string {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatViews(n: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ─── Clip card ────────────────────────────────────────────────────────────────

function ClipCard({
  item,
  selected,
  onToggle,
}: {
  item:     SourceItem;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'group relative text-left rounded-lg overflow-hidden border transition-all',
        selected
          ? 'border-primary ring-1 ring-primary'
          : 'border-border hover:border-border/80',
      )}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-muted overflow-hidden">
        {item.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbnailUrl}
            alt={item.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>
        )}
        {/* Duration badge */}
        {item.duration > 0 && (
          <span className="absolute bottom-1 right-1 bg-black/75 text-white text-[10px] px-1 rounded font-mono">
            {formatDuration(item.duration)}
          </span>
        )}
        {/* Selection overlay */}
        <div className={cn(
          'absolute inset-0 transition-opacity',
          selected ? 'bg-primary/20 opacity-100' : 'bg-black/0 opacity-0 group-hover:opacity-100 group-hover:bg-black/10',
        )}>
          {selected && (
            <div className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}
        </div>
      </div>

      {/* Title + meta */}
      <div className="p-2 space-y-0.5">
        <p className="text-xs font-medium text-foreground line-clamp-2 leading-tight">{item.title}</p>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {item.viewCount > 0 && <span>{formatViews(item.viewCount)} views</span>}
          {item.type && (
            <span className="capitalize px-1 py-0.5 rounded bg-muted text-muted-foreground/70">{item.type}</span>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  onSelect: (urls: string[]) => void;
  maxSelect?: number;
}

export function SourceLibraryPicker({ onSelect, maxSelect = 10 }: Props) {
  const { getToken }                  = useAuth();
  const [activePlatform, setActive]   = useState<SourcePlatform | null>(null);
  const [username, setUsername]       = useState('');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [items, setItems]             = useState<SourceItem[]>([]);
  const [channelName, setChannelName] = useState('');
  const [selected, setSelected]       = useState<Set<string>>(new Set());

  const handlePlatformSelect = useCallback((platform: SourcePlatform) => {
    setActive(platform);
    setUsername('');
    setItems([]);
    setSelected(new Set());
    setError(null);
    setChannelName('');
  }, []);

  const handleBrowse = useCallback(async () => {
    if (!activePlatform || !username.trim()) return;
    setLoading(true);
    setError(null);
    setItems([]);
    setSelected(new Set());
    try {
      const token = await getToken();
      const res   = await fetchSourceContent(activePlatform, username.trim(), 20, token ?? undefined);
      setItems(res.items);
      setChannelName(res.channel?.displayName || res.channel?.name || username.trim());
      if (res.items.length === 0) {
        setError(`No public content found for "${username.trim()}" on ${activePlatform}.`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load content — check the username and try again.');
    } finally {
      setLoading(false);
    }
  }, [activePlatform, username, getToken]);

  const toggleItem = useCallback((item: SourceItem) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.url)) {
        next.delete(item.url);
      } else if (next.size < maxSelect) {
        next.add(item.url);
      }
      return next;
    });
  }, [maxSelect]);

  const handleConfirm = useCallback(() => {
    onSelect(Array.from(selected));
  }, [selected, onSelect]);

  const cfg = PLATFORMS.find((p) => p.id === activePlatform);

  return (
    <div className="space-y-4">
      {/* Platform tiles */}
      <div className="grid grid-cols-3 gap-2">
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => handlePlatformSelect(p.id)}
            className={cn(
              'flex flex-col items-center gap-2 p-3 rounded-lg border transition-all text-center',
              activePlatform === p.id
                ? `${p.border} ${p.bg}`
                : 'border-border hover:border-border/70 hover:bg-muted/40',
            )}
          >
            {p.icon}
            <span className={cn('text-xs font-medium', activePlatform === p.id ? p.accent : 'text-foreground/70')}>
              {p.label}
            </span>
          </button>
        ))}
      </div>

      {/* Username input */}
      {activePlatform && cfg && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className={cn('absolute left-3 top-1/2 -translate-y-1/2', cfg.accent)}>
                {cfg.icon}
              </span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleBrowse()}
                placeholder={cfg.placeholder}
                className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <button
              type="button"
              onClick={handleBrowse}
              disabled={!username.trim() || loading}
              className={cn(
                'px-3 h-9 text-xs rounded-md border font-medium transition-colors shrink-0',
                'bg-primary text-primary-foreground border-primary',
                'hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {loading ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : 'Browse'}
            </button>
          </div>

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</p>
          )}
        </div>
      )}

      {/* Results grid */}
      {items.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{channelName}</span>
              {' '}· {items.length} clips
              {selected.size > 0 && (
                <span className="ml-1.5 text-primary font-medium">· {selected.size} selected</span>
              )}
            </p>
            {selected.size > 0 && (
              <p className="text-[10px] text-muted-foreground">max {maxSelect}</p>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-80 overflow-y-auto pr-1">
            {items.map((item) => (
              <ClipCard
                key={item.id}
                item={item}
                selected={selected.has(item.url)}
                onToggle={() => toggleItem(item)}
              />
            ))}
          </div>

          {/* Confirm button */}
          <button
            type="button"
            onClick={handleConfirm}
            disabled={selected.size === 0}
            className={cn(
              'w-full h-9 text-sm rounded-md border font-medium transition-colors',
              selected.size > 0
                ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90'
                : 'border-border text-muted-foreground cursor-not-allowed opacity-50',
            )}
          >
            {selected.size === 0
              ? 'Select clips to continue'
              : `Use ${selected.size} clip${selected.size > 1 ? 's' : ''}`}
          </button>
        </div>
      )}
    </div>
  );
}
