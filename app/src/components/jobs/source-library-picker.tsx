'use client';
/**
 * SourceLibraryPicker — Creator Source Library (CPD-274 / CPD-285)
 *
 * Platform-branded content browser with filters:
 *   - Date range: 24h / 7d / 30d / All
 *   - Content type: All / VODs / Clips / Shorts (platform-aware)
 *   - Duration: min/max in seconds (applied client-side after fetch)
 *   - Keyword: title search (client-side)
 *   - Playlist: YouTube only
 *
 * onSelect receives full SourceItem[] (not just URLs) so the ClipEditor can
 * auto-populate title / thumbnail / duration.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useAuth } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import {
  fetchSourceContent,
  fetchYouTubePlaylists,
  type SourcePlatform,
  type SourceItem,
  type SourceFilters,
  type SourceDateRange,
  type SourceType,
  type SourcePlaylist,
} from '@/lib/api';

// ─── Platform config ──────────────────────────────────────────────────────────

const PLATFORMS: {
  id:          SourcePlatform;
  label:       string;
  placeholder: string;
  accent:      string;
  accentBg:    string;
  border:      string;
  activeBorder: string;
  icon:        React.ReactNode;
  typeOptions: { value: SourceType; label: string }[];
}[] = [
  {
    id:           'twitch',
    label:        'Twitch',
    placeholder:  'e.g. hasanabi',
    accent:       'text-purple-400',
    accentBg:     'bg-purple-500/10',
    border:       'border-purple-500/30',
    activeBorder: 'border-purple-500',
    typeOptions:  [
      { value: 'all',  label: 'All' },
      { value: 'vod',  label: 'VODs' },
      { value: 'clip', label: 'Clips' },
    ],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
      </svg>
    ),
  },
  {
    id:           'kick',
    label:        'Kick',
    placeholder:  'e.g. n3on',
    accent:       'text-green-400',
    accentBg:     'bg-green-500/10',
    border:       'border-green-500/30',
    activeBorder: 'border-green-500',
    typeOptions:  [
      { value: 'all',  label: 'All' },
      { value: 'vod',  label: 'VODs' },
      { value: 'clip', label: 'Clips' },
    ],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
        <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm-1 14H9V8h2v8zm5-4l-4 4V8l4 4z"/>
      </svg>
    ),
  },
  {
    id:           'youtube',
    label:        'YouTube',
    placeholder:  'e.g. @LazarBeam',
    accent:       'text-red-400',
    accentBg:     'bg-red-500/10',
    border:       'border-red-500/30',
    activeBorder: 'border-red-500',
    typeOptions:  [
      { value: 'all',   label: 'All' },
      { value: 'video', label: 'Videos' },
      { value: 'short', label: 'Shorts' },
    ],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
        <path d="M23.495 6.205a3.007 3.007 0 0 0-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 0 0 .527 6.205a31.247 31.247 0 0 0-.522 5.805 31.247 31.247 0 0 0 .522 5.783 3.007 3.007 0 0 0 2.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 0 0 2.088-2.088 31.247 31.247 0 0 0 .5-5.783 31.247 31.247 0 0 0-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/>
      </svg>
    ),
  },
];

const DATE_RANGES: { value: SourceDateRange; label: string }[] = [
  { value: 'all', label: 'All time'  },
  { value: '24h', label: 'Last 24h'  },
  { value: '7d',  label: 'Last 7d'   },
  { value: '30d', label: 'Last 30d'  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(s: number): string {
  if (!s) return '';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatViews(n: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const DURATION_PRESETS = [
  { label: 'Any',      min: 0,    max: 99999 },
  { label: '< 1 min',  min: 0,    max: 59    },
  { label: '1–5 min',  min: 60,   max: 299   },
  { label: '5–30 min', min: 300,  max: 1799  },
  { label: '30+ min',  min: 1800, max: 99999 },
];

// ─── Clip card ────────────────────────────────────────────────────────────────

function ClipCard({
  item, selected, onToggle, accentBorder,
}: {
  item:         SourceItem;
  selected:     boolean;
  onToggle:     () => void;
  accentBorder: string;
}) {
  const [imgError, setImgError] = useState(false);
  const contentType = item.contentType || item.type || '';

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'group relative text-left rounded-xl overflow-hidden border-2 transition-all duration-150',
        selected
          ? `${accentBorder} ring-2 ring-offset-1 ring-offset-background`
          : 'border-border/40 hover:border-border',
      )}
    >
      {/* Thumbnail — 16:9 */}
      <div className="relative aspect-video bg-muted overflow-hidden">
        {item.thumbnailUrl && !imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbnailUrl}
            alt={item.title}
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-muted">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" className="text-muted-foreground/30">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>
        )}

        {/* Duration badge */}
        {item.duration > 0 && (
          <span className="absolute bottom-1.5 right-1.5 bg-black/80 text-white text-[10px] px-1.5 py-0.5 rounded font-mono tracking-tight">
            {formatDuration(item.duration)}
          </span>
        )}

        {/* Content-type badge */}
        {contentType && contentType !== 'video' && (
          <span className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold">
            {contentType}
          </span>
        )}

        {/* Selection overlay */}
        <div className={cn(
          'absolute inset-0 transition-opacity',
          selected
            ? 'bg-primary/25 opacity-100'
            : 'opacity-0 group-hover:opacity-100 bg-black/15',
        )}>
          {selected && (
            <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-primary shadow-lg flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}
        </div>
      </div>

      {/* Title + meta */}
      <div className="p-2.5 space-y-1 bg-card">
        <p className="text-xs font-medium text-foreground line-clamp-2 leading-snug">{item.title}</p>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {item.viewCount > 0 && <span>{formatViews(item.viewCount)} views</span>}
          {item.publishedAt && (
            <span className="ml-auto shrink-0">{formatDate(item.publishedAt)}</span>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Filter pill ──────────────────────────────────────────────────────────────

function FilterPill({
  active, children, onClick,
}: {
  active: boolean; children: React.ReactNode; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 text-[11px] rounded-full border font-medium transition-all whitespace-nowrap',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'border-border text-muted-foreground hover:border-border/70 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  onSelect:   (items: SourceItem[]) => void;
  maxSelect?: number;
}

export function SourceLibraryPicker({ onSelect, maxSelect = 10 }: Props) {
  const { getToken }                    = useAuth();
  const [platform, setPlatform]         = useState<SourcePlatform | null>(null);
  const [username, setUsername]         = useState('');
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [items, setItems]               = useState<SourceItem[]>([]);
  const [channelName, setChannelName]   = useState('');
  const [selected, setSelected]         = useState<Set<string>>(new Set());

  // Filters
  const [dateRange, setDateRange]       = useState<SourceDateRange>('all');
  const [contentType, setContentType]   = useState<SourceType>('all');
  const [durationPreset, setDurationPreset] = useState(0); // index into DURATION_PRESETS
  const [keyword, setKeyword]           = useState('');

  // YouTube extras
  const [playlists, setPlaylists]       = useState<SourcePlaylist[]>([]);
  const [activePlaylist, setActivePlaylist] = useState<string | null>(null);

  // Track which channel+platform combo we've already loaded playlists for
  const playlistLoadedFor = useRef<string | null>(null);

  const cfg = PLATFORMS.find((p) => p.id === platform);

  // Keyword filter is applied client-side for responsiveness
  const displayItems = useMemo(() => {
    if (!keyword.trim()) return items;
    const q = keyword.toLowerCase();
    return items.filter((i) => i.title.toLowerCase().includes(q));
  }, [items, keyword]);

  // Load YouTube playlists exactly once per channel browse
  useEffect(() => {
    if (platform !== 'youtube' || !channelName) return;
    const key = `${platform}:${username.trim()}`;
    if (playlistLoadedFor.current === key) return;
    playlistLoadedFor.current = key;
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const res = await fetchYouTubePlaylists(username.trim(), token ?? undefined);
        if (!cancelled && res.playlists?.length) setPlaylists(res.playlists);
      } catch { /* playlists are a bonus, not required */ }
    })();
    return () => { cancelled = true; };
  }, [platform, username, channelName, getToken]);

  const handlePlatformSelect = useCallback((p: SourcePlatform) => {
    setPlatform(p);
    setUsername('');
    setItems([]);
    setSelected(new Set());
    setError(null);
    setChannelName('');
    setPlaylists([]);
    setActivePlaylist(null);
    setDateRange('all');
    setContentType('all');
    setDurationPreset(0);
    setKeyword('');
    playlistLoadedFor.current = null;
  }, []);

  /**
   * durationPresetIdx is passed explicitly to avoid stale closure
   * (setDurationPreset + doFetch called synchronously — state not yet committed).
   * isNewChannel: true = reset selections; false = preserve selections that
   * survive the new result set.
   */
  const doFetch = useCallback(async (
    targetPlatform: SourcePlatform,
    targetUsername: string,
    filters: SourceFilters,
    durationPresetIdx: number,
    isNewChannel = false,
  ) => {
    setLoading(true);
    setError(null);
    setItems([]);
    try {
      const token  = await getToken();
      const preset = DURATION_PRESETS[durationPresetIdx];
      const f: SourceFilters = {
        ...filters,
        minDuration: preset.min > 0     ? preset.min    : undefined,
        maxDuration: preset.max < 99999 ? preset.max    : undefined,
      };
      const res = await fetchSourceContent(targetPlatform, targetUsername, 50, token ?? undefined, f);
      const newItems = res.items;
      setItems(newItems);
      setChannelName(res.channel?.displayName || res.channel?.name || targetUsername);
      if (isNewChannel) {
        setSelected(new Set());
      } else {
        // Preserve selections whose URLs still appear in the new result set
        const newUrls = new Set(newItems.map((i) => i.url));
        setSelected((prev) => {
          const next = new Set<string>();
          for (const url of prev) { if (newUrls.has(url)) next.add(url); }
          return next;
        });
      }
      if (!newItems.length) {
        setError(`no-results:No content found for "${targetUsername}" on ${targetPlatform} with these filters. Try a wider date range or "All" type.`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load content — check the username and try again.');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  const handleBrowse = useCallback(() => {
    if (!platform || !username.trim()) return;
    doFetch(platform, username.trim(), {
      dateRange,
      type: contentType,
      playlistId: activePlaylist ?? undefined,
    }, durationPreset, true /* new channel browse = reset selections */);
  }, [platform, username, dateRange, contentType, activePlaylist, durationPreset, doFetch]);

  // Re-fetch when server-side filters change (only if already browsed)
  const handleFilterChange = useCallback((
    patch: Partial<SourceFilters & { dateRange: SourceDateRange; type: SourceType }>,
    newDurationPresetIdx?: number,
  ) => {
    if (!platform || !username.trim() || !channelName) return;
    const newDateRange    = patch.dateRange   ?? dateRange;
    const newContentType  = patch.type        ?? contentType;
    const newPlaylistId   = patch.playlistId  ?? activePlaylist ?? undefined;
    const presetIdx       = newDurationPresetIdx ?? durationPreset;
    if (patch.dateRange  !== undefined) setDateRange(newDateRange);
    if (patch.type       !== undefined) setContentType(newContentType);
    if (patch.playlistId !== undefined) setActivePlaylist(patch.playlistId ?? null);
    doFetch(platform, username.trim(), {
      dateRange:  newDateRange,
      type:       newContentType,
      playlistId: newPlaylistId,
    }, presetIdx, false /* preserve surviving selections */);
  }, [platform, username, channelName, dateRange, contentType, activePlaylist, durationPreset, doFetch]);

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
    const chosen = items.filter((i) => selected.has(i.url));
    onSelect(chosen);
  }, [items, selected, onSelect]);

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
              'flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all',
              platform === p.id
                ? `${p.activeBorder} ${p.accentBg}`
                : 'border-border/40 hover:border-border',
            )}
          >
            <span className={cn(platform === p.id ? p.accent : 'text-muted-foreground')}>{p.icon}</span>
            <span className={cn('text-xs font-semibold', platform === p.id ? p.accent : 'text-foreground/70')}>
              {p.label}
            </span>
          </button>
        ))}
      </div>

      {/* Username input */}
      {platform && cfg && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className={cn('absolute left-3 top-1/2 -translate-y-1/2', cfg.accent)}>{cfg.icon}</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleBrowse()}
              placeholder={cfg.placeholder}
              className="w-full h-9 pl-9 pr-3 text-sm rounded-lg border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <button
            type="button"
            onClick={handleBrowse}
            disabled={!username.trim() || loading}
            className="px-4 h-9 text-xs rounded-lg border font-semibold transition-colors shrink-0 bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
              : 'Browse'}
          </button>
        </div>
      )}

      {error && (() => {
        const isNoResults = error.startsWith('no-results:');
        const msg = isNoResults ? error.slice('no-results:'.length) : error;
        return (
          <p className={cn(
            'text-xs px-3 py-2 rounded-lg',
            isNoResults
              ? 'text-muted-foreground bg-muted/40 border border-border/50'
              : 'text-destructive bg-destructive/10',
          )}>{msg}</p>
        );
      })()}

      {/* Filter bar — shown once we have results (or channel is loaded) */}
      {platform && cfg && channelName && (
        <div className="space-y-2.5 border border-border/50 rounded-xl p-3 bg-muted/20">

          {/* Channel header */}
          <div className="flex items-center gap-2">
            <span className={cn('text-xs font-semibold', cfg.accent)}>{cfg.icon}</span>
            <span className="text-xs font-semibold text-foreground">{channelName}</span>
            <span className="text-[10px] text-muted-foreground ml-auto">
              {displayItems.length} result{displayItems.length !== 1 ? 's' : ''}
              {selected.size > 0 && <span className="text-primary font-semibold"> · {selected.size} selected</span>}
            </span>
          </div>

          {/* Date range pills */}
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Date</p>
            <div className="flex flex-wrap gap-1.5">
              {DATE_RANGES.map((r) => (
                <FilterPill
                  key={r.value}
                  active={dateRange === r.value}
                  onClick={() => handleFilterChange({ dateRange: r.value })}
                >
                  {r.label}
                </FilterPill>
              ))}
            </div>
          </div>

          {/* Content type pills */}
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Type</p>
            <div className="flex flex-wrap gap-1.5">
              {cfg.typeOptions.map((t) => (
                <FilterPill
                  key={t.value}
                  active={contentType === t.value}
                  onClick={() => handleFilterChange({ type: t.value })}
                >
                  {t.label}
                </FilterPill>
              ))}
            </div>
          </div>

          {/* Duration presets */}
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Duration</p>
            <div className="flex flex-wrap gap-1.5">
              {DURATION_PRESETS.map((d, i) => (
                <FilterPill
                  key={d.label}
                  active={durationPreset === i}
                  onClick={() => {
                    setDurationPreset(i);
                    // Pass index directly to avoid stale closure bug
                    handleFilterChange({}, i);
                  }}
                >
                  {d.label}
                </FilterPill>
              ))}
            </div>
          </div>

          {/* YouTube playlists */}
          {platform === 'youtube' && playlists.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Playlist</p>
              <div className="flex flex-wrap gap-1.5">
                <FilterPill
                  active={activePlaylist === null}
                  onClick={() => handleFilterChange({ playlistId: undefined })}
                >
                  All uploads
                </FilterPill>
                {playlists.map((pl) => (
                  <FilterPill
                    key={pl.id}
                    active={activePlaylist === pl.id}
                    onClick={() => handleFilterChange({ playlistId: pl.id })}
                  >
                    {pl.title}
                  </FilterPill>
                ))}
              </div>
            </div>
          )}

          {/* Keyword search — client-side */}
          <div className="relative">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Filter by title…"
              className="w-full h-8 pl-8 pr-3 text-xs rounded-lg border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {keyword && (
              <button
                type="button"
                onClick={() => setKeyword('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Results grid — shown while loading (skeleton) or once items exist */}
      {(loading && channelName) || displayItems.length > 0 ? (
        <div className="space-y-3">
          {/* Scroll container with bottom fade hint */}
          <div className="relative">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[420px] overflow-y-auto pr-1">
              {loading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="rounded-xl overflow-hidden border border-border/30 animate-pulse">
                      <div className="aspect-video bg-muted" />
                      <div className="p-2.5 space-y-1.5 bg-card">
                        <div className="h-2.5 bg-muted rounded w-3/4" />
                        <div className="h-2 bg-muted rounded w-1/2" />
                      </div>
                    </div>
                  ))
                : displayItems.map((item) => (
                    <ClipCard
                      key={item.id}
                      item={item}
                      selected={selected.has(item.url)}
                      onToggle={() => toggleItem(item)}
                      accentBorder={cfg?.activeBorder ?? 'border-primary'}
                    />
                  ))}
            </div>
            {/* Bottom fade hint when content overflows */}
            {displayItems.length > 5 && (
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-background to-transparent" />
            )}
          </div>

          {/* Confirm strip */}
          {!loading && (
            <div className={cn(
              'flex items-center gap-3 p-3 rounded-xl border transition-all',
              selected.size > 0 ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/20',
            )}>
              <div className="flex-1 min-w-0">
                {selected.size > 0 ? (
                  <p className="text-xs font-medium text-foreground truncate">
                    {selected.size} of {maxSelect} clips selected
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Select up to {maxSelect} clips to add to your job
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={selected.size === 0}
                className="px-4 h-8 text-xs rounded-lg border font-semibold transition-colors shrink-0 bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {selected.size === 0 ? 'Select clips' : `Add ${selected.size} clip${selected.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
