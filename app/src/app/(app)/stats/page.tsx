'use client';

/**
 * Creator Stats — post-publish performance (Upload-Post + YouTube lite).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/clerk-compat';
import { useBrand } from '@/contexts/brand-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import {
  fetchStatsSummary,
  fetchStatsPosts,
  type StatsPostRow,
  type StatsSummaryResponse,
} from '@/lib/api';

type PlatformTab = 'all' | 'youtube' | 'tiktok' | 'instagram';

const TABS: { id: PlatformTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
];

function fmt(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export default function StatsPage() {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand, isLoading: brandLoading } = useBrand();
  const [tab, setTab] = useState<PlatformTab>('all');
  const [summary, setSummary] = useState<StatsSummaryResponse | null>(null);
  const [posts, setPosts] = useState<StatsPostRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isLoaded || brandLoading) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const [s, p] = await Promise.all([
        fetchStatsSummary(token),
        fetchStatsPosts(20, token),
      ]);
      setSummary(s);
      setPosts(p.posts || []);
      if (!s.ok && s.error) setError(s.error);
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Failed to load stats'));
      setSummary(null);
      setPosts([]);
    } finally {
      setBusy(false);
    }
  }, [isLoaded, brandLoading, getToken, activeBrand?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = summary?.connected || [];
  const upPlatforms = summary?.uploadPost?.platforms || {};

  const visibleRollups = useMemo(() => {
    const keys = tab === 'all' ? (['youtube', 'tiktok', 'instagram'] as const) : [tab];
    return keys.map((p) => ({
      platform: p,
      connected: connected.some((c) => c.platform === p),
      handle: connected.find((c) => c.platform === p)?.handle || null,
      rollup: upPlatforms[p] || null,
    }));
  }, [tab, connected, upPlatforms]);

  const visiblePosts = useMemo(() => {
    if (tab === 'all') return posts;
    return posts.filter((post) => post.platforms.some((p) => p.platform === tab));
  }, [posts, tab]);

  return (
    <PageShell maxWidth="5xl">
      <PageHeader
        title="Stats"
        subtitle="Post-publish performance for this brand. Metrics vary by platform — we only show what each network returns."
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
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => void load()} disabled={busy}>
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
          {error}
        </div>
      )}
      {busy && <p className="af-caption text-muted-foreground mb-4">Loading stats…</p>}

      {!busy && !connected.length && (
        <Card className="mb-4 border-slate-800 bg-slate-900/50">
          <CardContent className="pt-5 space-y-3">
            <p className="text-sm text-slate-300">
              Connect YouTube, TikTok, or Instagram under Social to see post-publish stats.
            </p>
            <Link href="/settings/social" className="text-sm font-semibold text-amber-400 hover:underline">
              Open Social settings →
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        {visibleRollups.map((row) => (
          <Card key={row.platform} className="border-slate-800 bg-slate-900/50">
            <CardContent className="pt-5 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {row.platform}
                </p>
                <span className={cn(
                  'text-[10px] font-semibold uppercase',
                  row.connected ? 'text-emerald-400' : 'text-slate-600',
                )}>
                  {row.connected ? 'Connected' : 'Not connected'}
                </span>
              </div>
              {row.handle && <p className="text-xs text-slate-400 truncate">{row.handle}</p>}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <Metric label="Followers" value={row.rollup?.followers} />
                <Metric label="Views" value={row.rollup?.views} />
                <Metric label="Impressions" value={row.rollup?.impressions} />
                <Metric label="Likes" value={row.rollup?.likes} />
              </div>
              {!row.rollup && row.connected && (
                <p className="text-[11px] text-slate-500 pt-1">
                  No Upload-Post rollup yet for this platform.
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {(tab === 'all' || tab === 'youtube') && summary?.youtube?.available && summary.youtube.summary && (
        <Card className="mb-6 border-slate-800 bg-slate-900/50">
          <CardContent className="pt-5 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              YouTube channel · {summary.youtube.source === 'youtube_analytics' ? 'Analytics window' : 'Lifetime totals'}
            </p>
            {summary.youtube.handle && (
              <p className="text-xs text-slate-400">{summary.youtube.handle}</p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {Object.entries(summary.youtube.summary).map(([k, v]) => (
                <Metric key={k} label={k.replace(/([A-Z])/g, ' $1')} value={v} />
              ))}
            </div>
            {summary.youtube.note && (
              <p className="text-[11px] text-slate-500 pt-1">{summary.youtube.note}</p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-200">Recent published posts</h2>
        {!busy && !visiblePosts.length && (
          <p className="text-sm text-slate-500">No published posts found for this brand yet.</p>
        )}
        {visiblePosts.map((post) => (
          <Card key={post.jobId} className="border-slate-800 bg-slate-900/40">
            <CardContent className="pt-4 space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-slate-100 line-clamp-2">{post.title}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {post.publishedAt ? new Date(post.publishedAt).toLocaleString() : 'Published'}
                    {' · '}
                    <Link href={`/myjobs/${post.jobId}`} className="text-amber-400/80 hover:underline">
                      Job
                    </Link>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {post.platforms.map((p) => (
                    p.url ? (
                      <a
                        key={`${post.jobId}-${p.platform}`}
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] font-semibold text-slate-300 border border-slate-700 rounded-md px-2 py-1 hover:border-amber-400/40"
                      >
                        {p.platform}
                      </a>
                    ) : (
                      <span
                        key={`${post.jobId}-${p.platform}`}
                        className="text-[11px] text-slate-500 border border-slate-800 rounded-md px-2 py-1"
                      >
                        {p.platform}
                      </span>
                    )
                  ))}
                </div>
              </div>
              {post.metrics && Object.keys(post.metrics).length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {Object.entries(post.metrics).map(([platform, m]) => (
                    <div key={platform} className="rounded-lg bg-slate-950/60 p-2">
                      <p className="text-[10px] uppercase text-slate-500 mb-1">{platform}</p>
                      <p className="text-xs text-slate-300">Views {fmt(m.views)}</p>
                      <p className="text-xs text-slate-300">Likes {fmt(m.likes)}</p>
                      <p className="text-xs text-slate-300">Comments {fmt(m.comments)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                post.metricsNote && (
                  <p className="text-[11px] text-slate-500">{post.metricsNote}</p>
                )
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}

function Metric({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-lg font-semibold text-slate-100 tabular-nums">{fmt(value)}</p>
    </div>
  );
}
