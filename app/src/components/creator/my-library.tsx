'use client';

/**
 * My Library — AuraFlux publishes + connected channel catalogs.
 * Clip from is a secondary mode (third-party creators).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/clerk-compat';
import { useBrand } from '@/contexts/brand-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { fetchMyLibrary, type MyLibraryResponse, type MyLibraryItem } from '@/lib/api';
import { ClipLibrary } from '@/components/creator/clip-library';

type Tab = 'auraflux' | 'youtube' | 'tiktok' | 'instagram' | 'clipfrom';

const TABS: { id: Tab; label: string }[] = [
  { id: 'auraflux', label: 'AuraFlux' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'clipfrom', label: 'Clip from' },
];

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

export function MyLibrary() {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand, isLoading: brandLoading } = useBrand();
  const [tab, setTab] = useState<Tab>('auraflux');
  const [data, setData] = useState<MyLibraryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (platform: Tab) => {
    if (platform === 'clipfrom') return;
    if (!isLoaded || brandLoading) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const res = await fetchMyLibrary(platform === 'auraflux' ? 'auraflux' : platform, token);
      setData(res);
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Failed to load library'));
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [getToken, isLoaded, brandLoading, activeBrand?.id]);

  useEffect(() => {
    if (tab === 'clipfrom') return;
    void load(tab);
  }, [tab, load]);

  if (tab === 'clipfrom') {
    return (
      <PageShell maxWidth="5xl">
        <div className="flex flex-wrap gap-2 mb-4">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors',
                tab === t.id
                  ? 'bg-amber-400/15 border-amber-400/40 text-amber-300'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <ClipLibrary embedded />
      </PageShell>
    );
  }

  const handles = data?.handles;
  const items: MyLibraryItem[] =
    tab === 'youtube'
      ? [
          ...(data?.channelCatalog || []),
          ...(data?.auraflux || []).filter((i) =>
            (i.platforms || []).some((p) => p.platform === 'youtube'),
          ),
        ]
      : (data?.auraflux || []);

  return (
    <PageShell maxWidth="5xl">
      <PageHeader
        title="Library"
        subtitle="Your AuraFlux publishes and content from channels you connect and publish to. Use Clip from to pull from other creators."
      />

      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors',
              tab === t.id
                ? 'bg-amber-400/15 border-amber-400/40 text-amber-300'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white',
            )}
          >
            {t.label}
          </button>
        ))}
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => void load(tab)} disabled={busy}>
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
          {error}
        </div>
      )}
      {busy && <p className="af-caption text-muted-foreground mb-4">Loading library…</p>}

      {tab === 'youtube' && (
        <p className="text-xs text-slate-500 mb-3">
          {handles?.youtube
            ? `YouTube catalog for ${handles.youtube} · plus AuraFlux posts to YouTube.`
            : 'Connect YouTube under Social (or set a handle under My Channels) to load your channel catalog.'}
          {!handles?.youtube && (
            <>
              {' '}
              <Link href="/settings/social" className="text-amber-400 hover:underline">Social settings</Link>
            </>
          )}
        </p>
      )}
      {tab === 'tiktok' && (
        <p className="text-xs text-slate-500 mb-3">
          {data?.notes?.tiktok}{' '}
          {handles?.tiktok ? `Connected: ${handles.tiktok}.` : (
            <Link href="/settings/social" className="text-amber-400 hover:underline">Connect TikTok</Link>
          )}
        </p>
      )}
      {tab === 'instagram' && (
        <p className="text-xs text-slate-500 mb-3">
          {data?.notes?.instagram}{' '}
          {handles?.instagram ? `Connected: ${handles.instagram}.` : (
            <Link href="/settings/social" className="text-amber-400 hover:underline">Connect Instagram</Link>
          )}
        </p>
      )}
      {data?.catalogNote && tab === 'youtube' && (
        <p className="text-xs text-amber-300/80 mb-3">{data.catalogNote}</p>
      )}

      {!busy && !items.length && (
        <Card className="border-slate-800 bg-slate-900/50">
          <CardContent className="pt-5 space-y-2">
            <p className="text-sm text-slate-300">Nothing here yet.</p>
            <p className="text-xs text-slate-500">
              Publish a Short from Jobs, or connect the channel under Social. Use Clip from to browse other creators.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Link href="/myjobs/new" className="text-xs font-semibold text-amber-400 hover:underline">New job →</Link>
              <Link href="/settings/social" className="text-xs font-semibold text-amber-400 hover:underline">Social →</Link>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map((item) => (
          <Card key={`${item.kind}-${item.id}`} className="border-slate-800 bg-slate-900/40 overflow-hidden">
            {item.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.thumbnailUrl} alt="" className="w-full aspect-video object-cover bg-slate-950" />
            ) : (
              <div className="w-full aspect-video bg-slate-950 flex items-center justify-center text-xs text-slate-600">
                No thumb
              </div>
            )}
            <CardContent className="pt-3 space-y-2">
              <p className="text-sm font-medium text-slate-100 line-clamp-2">{item.title || 'Untitled'}</p>
              <p className="text-[11px] text-slate-500">
                {item.kind === 'auraflux' ? 'AuraFlux' : item.platform || item.kind}
                {item.publishedAt ? ` · ${fmtDate(item.publishedAt)}` : ''}
              </p>
              <div className="flex flex-wrap gap-2">
                {item.kind === 'auraflux' && (
                  <Link href={`/myjobs/${item.id}`} className="text-[11px] font-semibold text-amber-400 hover:underline">
                    Job
                  </Link>
                )}
                {item.url && (
                  <a href={item.url} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-slate-300 hover:underline">
                    Open live
                  </a>
                )}
                {(item.platforms || []).filter((p) => p.url).map((p) => (
                  <a
                    key={`${item.id}-${p.platform}`}
                    href={p.url!}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-semibold text-slate-400 hover:underline capitalize"
                  >
                    {p.platform}
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
