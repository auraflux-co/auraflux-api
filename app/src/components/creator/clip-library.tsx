'use client';

/**
 * Clip from — multi-creator clip browse (third-party handles), not My Library.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/clerk-compat';
import { useBrand } from '@/contexts/brand-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import {
  fetchSourceContent,
  analyzeContentLibraryVod,
  type SourceItem,
  type SourcePlatform,
  type SourceDateRange,
} from '@/lib/api';
import {
  loadClipRoster,
  saveClipRoster,
  makeRosterId,
  normalizeHandle,
  type ClipRosterEntry,
} from '@/lib/clip-roster';

const DATE_PILLS: { id: SourceDateRange; label: string }[] = [
  { id: '24h', label: 'Last 24H' },
  { id: '7d', label: 'Last 7D' },
  { id: '30d', label: 'Last 30D' },
  { id: 'all', label: 'All time' },
];

type ClipSort = 'recent' | 'popular' | 'score';

function formatClock(sec: number) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Simple velocity score when Content Memory Score is unavailable. */
function clipScore(item: SourceItem): number {
  const views = Number(item.viewCount) || 0;
  const published = item.publishedAt ? new Date(item.publishedAt).getTime() : NaN;
  const ageHours = Number.isFinite(published)
    ? Math.max(1, (Date.now() - published) / 3600000)
    : 168;
  return views / ageHours;
}

function detectPlatformFromUrl(url: string): SourcePlatform | null {
  const u = url.toLowerCase();
  if (u.includes('twitch.tv') || u.includes('clips.twitch')) return 'twitch';
  if (u.includes('kick.com')) return 'kick';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  return null;
}

export function ClipLibrary({ embedded = false }: { embedded?: boolean } = {}) {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand, isLoading: brandLoading } = useBrand();
  const router = useRouter();
  const brandId = activeBrand?.id ?? null;

  const [roster, setRoster] = useState<ClipRosterEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [addPlatform, setAddPlatform] = useState<SourcePlatform>('twitch');
  const [addHandle, setAddHandle] = useState('');

  const [dateRange, setDateRange] = useState<SourceDateRange>('7d');
  const [minDuration, setMinDuration] = useState(0);
  const [maxDuration, setMaxDuration] = useState('');
  const [sort, setSort] = useState<ClipSort>('popular');

  const [items, setItems] = useState<(SourceItem & { _rosterId?: string })[]>([]);
  const [picked, setPicked] = useState<SourceItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const [pasteUrl, setPasteUrl] = useState('');

  useEffect(() => {
    if (brandLoading) return;
    const list = loadClipRoster(brandId);
    setRoster(list);
    setSelectedIds(new Set(list.map((e) => e.id)));
  }, [brandId, brandLoading]);

  const persistRoster = useCallback((next: ClipRosterEntry[]) => {
    setRoster(next);
    saveClipRoster(brandId, next);
  }, [brandId]);

  function addCreator() {
    const handle = normalizeHandle(addPlatform, addHandle);
    if (!addHandle.trim()) return;
    const id = makeRosterId(addPlatform, handle);
    if (roster.some((e) => e.id === id)) {
      setSelectedIds((prev) => new Set(prev).add(id));
      setAddHandle('');
      return;
    }
    const entry: ClipRosterEntry = { id, platform: addPlatform, handle };
    const next = [...roster, entry];
    persistRoster(next);
    setSelectedIds((prev) => new Set(prev).add(id));
    setAddHandle('');
  }

  function removeCreator(id: string) {
    persistRoster(roster.filter((e) => e.id !== id));
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const loadClips = useCallback(async () => {
    if (!isLoaded) return;
    const creators = roster.filter((e) => selectedIds.has(e.id));
    if (!creators.length) {
      setError('Select at least one creator in your roster.');
      return;
    }
    setBusy(`Loading clips from ${creators.length} creator${creators.length === 1 ? '' : 's'}…`);
    setError(null);
    setHint(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const maxDur = maxDuration.trim() === '' ? undefined : Math.max(0, parseInt(maxDuration, 10) || 0);
      const results = await Promise.allSettled(
        creators.map(async (c) => {
          const handle = c.handle.replace(/^@/, '');
          const res = await fetchSourceContent(c.platform, handle, 40, token, {
            dateRange,
            type: c.platform === 'youtube' ? 'all' : 'clip',
            minDuration: minDuration > 0 ? minDuration : undefined,
            maxDuration: maxDur,
          });
          return (res.items || []).map((item) => ({
            ...item,
            platform: item.platform || c.platform,
            _rosterId: c.id,
            _creator: c.handle,
          }));
        }),
      );
      const merged: (SourceItem & { _rosterId?: string; _creator?: string })[] = [];
      let fails = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') merged.push(...r.value);
        else fails += 1;
      }
      // Client duration filter (API may already filter)
      let filtered = merged.filter((i) => {
        const d = i.duration || 0;
        if (minDuration > 0 && d < minDuration) return false;
        if (maxDur != null && d > maxDur) return false;
        return true;
      });
      if (sort === 'popular') {
        filtered.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
      } else if (sort === 'score') {
        filtered.sort((a, b) => clipScore(b) - clipScore(a));
      } else {
        filtered.sort((a, b) => {
          const tb = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
          const ta = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
          return ta - tb;
        });
      }
      setItems(filtered);
      if (!filtered.length) {
        setHint(
          fails
            ? `No clips matched filters (${fails} creator fetch failed). Try All time or lower min duration.`
            : 'No clips matched these filters. Try All time, another creator, or lower min duration.',
        );
      } else if (fails) {
        setHint(`Loaded ${filtered.length} clips — ${fails} creator(s) failed to load.`);
      }
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Failed to load clips'));
      setItems([]);
    } finally {
      setBusy(null);
    }
  }, [
    isLoaded, getToken, roster, selectedIds, dateRange, minDuration, maxDuration, sort,
  ]);

  function togglePick(item: SourceItem) {
    setPicked((prev) => {
      const exists = prev.some((p) => p.url === item.url);
      if (exists) return prev.filter((p) => p.url !== item.url);
      if (prev.length >= 10) return prev;
      return [...prev, item];
    });
  }

  function createShort() {
    if (!picked.length) {
      setError('Select at least one clip, then Create Short.');
      return;
    }
    try {
      sessionStorage.setItem(
        'library_clip_handoff',
        JSON.stringify({
          clips: picked.map((c) => ({
            url: c.url,
            title: c.title,
            duration: c.duration,
            thumbnailUrl: c.thumbnailUrl,
            platform: c.platform,
            viewCount: c.viewCount,
            contentType: c.contentType || c.type,
          })),
        }),
      );
    } catch { /* ignore */ }
    router.push('/myjobs/new?from=library');
  }

  async function onPasteAnalyze() {
    const url = pasteUrl.trim();
    if (!url) return;
    setBusy('Finding peaks…');
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const platform = detectPlatformFromUrl(url) || 'youtube';
      const res = await analyzeContentLibraryVod({
        vodUrl: url,
        platform,
        targetSec: 45,
        maxPeaks: 8,
      }, token);
      sessionStorage.setItem(
        'library_peaks_handoff',
        JSON.stringify({ url, platform, segments: res.segments || [], mode: res.mode }),
      );
      setHint(
        (res.segments || []).length
          ? `Found ${res.segments!.length} peaks — opening Peaks to finish trim & Short.`
          : 'No peaks returned — opening Peaks so you can upload a trim.',
      );
      router.push('/peaks?from=library');
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Peak analyze failed'));
    } finally {
      setBusy(null);
    }
  }

  function onPasteAddPick() {
    const url = pasteUrl.trim();
    if (!url) return;
    const platform = detectPlatformFromUrl(url) || 'youtube';
    const item: SourceItem = {
      id: url,
      title: url,
      thumbnailUrl: null,
      duration: 0,
      url,
      type: platform === 'youtube' ? 'video' : 'clip',
      viewCount: 0,
      platform,
    };
    setPicked((prev) => (prev.some((p) => p.url === url) ? prev : [...prev, item].slice(0, 10)));
    setHint('URL added to picks — Create Short when ready.');
  }

  const selectedCreators = useMemo(
    () => roster.filter((e) => selectedIds.has(e.id)),
    [roster, selectedIds],
  );

  const body = (
    <>
      {!embedded && (
        <PageHeader
          title="Clip from"
          subtitle="Save creators you clip from, load their clips, filter and sort, then start a Short — or paste a URL."
        />
      )}
      {embedded && (
        <p className="text-sm text-slate-400 mb-4">
          Save creators you clip from, load their clips, filter and sort, then start a Short — or paste a URL.
        </p>
      )}

      {error && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-3">
          {error}
        </div>
      )}
      {hint && !error && (
        <div className="bg-amber-400/10 border border-amber-400/20 text-amber-300 rounded-xl p-3 text-xs font-medium mb-3">
          {hint}
        </div>
      )}
      {busy && <p className="af-caption text-muted-foreground mb-3">{busy}</p>}

      <Card className="mb-4 border-slate-800 bg-slate-900/50">
        <CardContent className="pt-5 space-y-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">
              Creators I clip from
            </p>
            <div className="flex flex-wrap gap-2 mb-3">
              {roster.length === 0 && (
                <p className="text-xs text-slate-500">Add Twitch, Kick, or YouTube handles below.</p>
              )}
              {roster.map((e) => {
                const on = selectedIds.has(e.id);
                return (
                  <div
                    key={e.id}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold',
                      on
                        ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                        : 'border-slate-800 text-slate-500',
                    )}
                  >
                    <button type="button" onClick={() => toggleSelected(e.id)} className="capitalize">
                      {e.platform} · {e.handle}
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${e.handle}`}
                      className="text-slate-500 hover:text-red-400"
                      onClick={() => removeCreator(e.id)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <Label className="text-[10px] uppercase text-slate-500">Platform</Label>
                <select
                  value={addPlatform}
                  onChange={(e) => setAddPlatform(e.target.value as SourcePlatform)}
                  className="mt-1 flex h-9 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-200"
                >
                  <option value="twitch">Twitch</option>
                  <option value="kick">Kick</option>
                  <option value="youtube">YouTube</option>
                </select>
              </div>
              <div className="flex-1 min-w-[10rem]">
                <Label htmlFor="lib-add-handle" className="text-[10px] uppercase text-slate-500">Handle</Label>
                <Input
                  id="lib-add-handle"
                  value={addHandle}
                  onChange={(e) => setAddHandle(e.target.value)}
                  placeholder={addPlatform === 'youtube' ? '@channel' : 'login'}
                  className="mt-1"
                  onKeyDown={(e) => { if (e.key === 'Enter') addCreator(); }}
                />
              </div>
              <Button type="button" variant="outline" onClick={addCreator} className="border-slate-700">
                Add
              </Button>
              <Button type="button" onClick={() => void loadClips()} disabled={!!busy || !selectedCreators.length}>
                Load clips
              </Button>
            </div>
          </div>

          <div className="border-t border-slate-800 pt-3 space-y-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">When</p>
              <div className="flex flex-wrap gap-1.5">
                {DATE_PILLS.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    disabled={!!busy}
                    onClick={() => setDateRange(w.id)}
                    className={cn(
                      'rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
                      dateRange === w.id
                        ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                        : 'border-slate-800 text-slate-500 hover:text-slate-300',
                    )}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="lib-min" className="text-[10px] uppercase text-slate-500">Min (s)</Label>
                <Input
                  id="lib-min"
                  type="number"
                  min={0}
                  value={minDuration}
                  onChange={(e) => setMinDuration(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="w-24 mt-1"
                />
              </div>
              <div>
                <Label htmlFor="lib-max" className="text-[10px] uppercase text-slate-500">Max (s)</Label>
                <Input
                  id="lib-max"
                  type="number"
                  min={0}
                  placeholder="any"
                  value={maxDuration}
                  onChange={(e) => setMaxDuration(e.target.value)}
                  className="w-24 mt-1"
                />
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Sort</p>
                <div className="flex gap-1.5">
                  {(['recent', 'popular', 'score'] as ClipSort[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={!!busy}
                      onClick={() => setSort(s)}
                      className={cn(
                        'rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold capitalize',
                        sort === s
                          ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                          : 'border-slate-800 text-slate-500 hover:text-slate-300',
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {sort === 'score' && (
              <p className="text-[10px] text-slate-500">
                Score ranks by views per hour since publish (velocity). Re-load clips after changing filters.
              </p>
            )}
          </div>

          <div className="border-t border-slate-800 pt-3 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Paste URL</p>
            <div className="flex flex-wrap gap-2">
              <Input
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
                placeholder="YouTube / Twitch / Kick clip or VOD URL"
                className="flex-1 min-w-[14rem]"
              />
              <Button type="button" variant="outline" className="border-slate-700" disabled={!!busy || !pasteUrl.trim()} onClick={onPasteAddPick}>
                Add to picks
              </Button>
              <Button type="button" disabled={!!busy || !pasteUrl.trim()} onClick={() => void onPasteAnalyze()}>
                Analyze peaks
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className="text-xs text-slate-400">
          {items.length} clip{items.length === 1 ? '' : 's'}
          {picked.length ? ` · ${picked.length} selected` : ''}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="border-slate-700"
            disabled={!picked.length}
            onClick={() => setPicked([])}
          >
            Clear picks
          </Button>
          <Button type="button" disabled={!picked.length || !!busy} onClick={createShort}>
            Create Short ({picked.length})
          </Button>
          <Link
            href="/peaks"
            className="inline-flex items-center justify-center rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:text-amber-400"
          >
            Peaks →
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => {
          const selected = picked.some((p) => p.url === item.url);
          return (
            <button
              key={`${item.url}-${item.id}`}
              type="button"
              onClick={() => togglePick(item)}
              className={cn(
                'text-left rounded-xl border overflow-hidden transition-colors bg-slate-900/40',
                selected ? 'border-amber-400 ring-1 ring-amber-400/40' : 'border-slate-800 hover:border-slate-700',
              )}
            >
              <div className="aspect-video bg-slate-950 relative">
                {item.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-600 text-xs">No thumb</div>
                )}
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                  {formatClock(item.duration || 0)}
                </span>
              </div>
              <div className="p-3 space-y-1">
                <p className="text-sm font-medium line-clamp-2 text-slate-100">{item.title || 'Untitled'}</p>
                <p className="text-[11px] text-slate-500 capitalize">
                  {item.platform || 'clip'}
                  {(item as { _creator?: string })._creator
                    ? ` · ${(item as { _creator?: string })._creator}`
                    : ''}
                  {item.viewCount ? ` · ${item.viewCount.toLocaleString()} views` : ''}
                  {sort === 'score' ? ` · score ${clipScore(item).toFixed(1)}` : ''}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );

  if (embedded) return <div className="space-y-1">{body}</div>;
  return <PageShell maxWidth="5xl">{body}</PageShell>;
}
