'use client';

/**
 * Library — Mine | Channels (Clip from tab hidden).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/clerk-compat';
import { useBrand } from '@/contexts/brand-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { fetchMyLibrary, type MyLibraryResponse, type MyLibraryItem } from '@/lib/api';

type PrimaryTab = 'mine' | 'channels';
type ChannelPlatform = 'youtube' | 'tiktok' | 'instagram';

const PRIMARY_TABS: { id: PrimaryTab; label: string }[] = [
  { id: 'mine', label: 'Mine' },
  { id: 'channels', label: 'Channels' },
  // Clip from hidden from Library IA (still available via dedicated flows elsewhere)
];

const CHANNEL_CHIPS: { id: ChannelPlatform; label: string }[] = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
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
  const [primary, setPrimary] = useState<PrimaryTab>('mine');
  const [channel, setChannel] = useState<ChannelPlatform>('youtube');
  const [data, setData] = useState<MyLibraryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiPlatform = primary === 'mine' ? 'auraflux' : channel;

  const load = useCallback(async () => {
    if (!isLoaded || brandLoading) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const res = await fetchMyLibrary(apiPlatform, token);
      setData(res);
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Failed to load library'));
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [getToken, isLoaded, brandLoading, activeBrand?.id, primary, apiPlatform]);

  useEffect(() => {
    void load();
  }, [primary, channel, load]);

  const handles = data?.handles;
  const items: MyLibraryItem[] =
    primary === 'channels' && channel === 'youtube'
      ? [
          ...(data?.channelCatalog || []),
          ...(data?.auraflux || []).filter((i) =>
            (i.platforms || []).some((p) => p.platform === 'youtube'),
          ),
        ]
      : (data?.auraflux || []);

  return (
    <PageShell maxWidth="full">
      <PageHeader
        title="Library"
        subtitle="Your publishes and connected channel catalogs — one place."
      />

      <div className="flex flex-wrap gap-2 mb-3">
        {PRIMARY_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setPrimary(t.id)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors',
              primary === t.id
                ? 'bg-amber-400/15 border-amber-400/40 text-amber-300'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white',
            )}
          >
            {t.label}
          </button>
        ))}
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => void load()} disabled={busy}>
          Refresh
        </Button>
      </div>

      {primary === 'channels' && (
        <div className="flex flex-wrap gap-2 mb-4">
          {CHANNEL_CHIPS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setChannel(c.id)}
              className={cn(
                'px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors',
                channel === c.id
                  ? 'bg-slate-800 border-amber-400/30 text-amber-300'
                  : 'bg-transparent border-slate-700 text-slate-500 hover:text-slate-300',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {error && (
            <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
              {error}
            </div>
          )}
      {busy && <PageSkeleton rows={3} className="mb-4" />}

      {primary === 'mine' && !busy && (
        <p className="text-xs text-slate-500 mb-3">
          AuraFlux jobs published for this brand.
        </p>
      )}
      {primary === 'channels' && channel === 'youtube' && (
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
      {primary === 'channels' && channel === 'tiktok' && (
        <p className="text-xs text-slate-500 mb-3">
          {data?.notes?.tiktok}{' '}
          {handles?.tiktok ? `Connected: ${handles.tiktok}.` : (
            <Link href="/settings/social" className="text-amber-400 hover:underline">Connect TikTok</Link>
          )}
        </p>
      )}
      {primary === 'channels' && channel === 'instagram' && (
        <p className="text-xs text-slate-500 mb-3">
          {data?.notes?.instagram}{' '}
          {handles?.instagram ? `Connected: ${handles.instagram}.` : (
            <Link href="/settings/social" className="text-amber-400 hover:underline">Connect Instagram</Link>
          )}
        </p>
      )}
      {data?.catalogNote && primary === 'channels' && channel === 'youtube' && (
        <p className="text-xs text-amber-300/80 mb-3">{data.catalogNote}</p>
      )}

      {!busy && !items.length && (
        <EmptyState
          size="sm"
          title="Nothing here yet"
          description={
            primary === 'mine'
              ? 'Publish a Short from Jobs to see it here.'
              : 'Connect the channel under Social, or publish to it from a job.'
          }
          action={{ label: 'New job', href: '/myjobs/new' }}
        />
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
