'use client';
/**
 * /dashboard/admin/overview — CPD-177
 *
 * Superuser command centre: platform-wide activity, account stats, and recent
 * job feed across all customer accounts. Admin role only.
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';
import { getActivityOverview, type ActivityOverview, type ActivityFeedItem, type AccountActivity } from '@/lib/api';
import { tierLabel } from '@/lib/tier-labels';
import { cn } from '@/lib/utils';

// ── helpers ───────────────────────────────────────────────────────────────────

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_DOT: Record<string, string> = {
  running:   'bg-blue-500',
  complete:  'bg-emerald-500',
  published: 'bg-violet-500',
  failed:    'bg-red-500',
  pending:   'bg-slate-400',
};

const STATUS_PILL: Record<string, string> = {
  running:   'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  complete:  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  published: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  failed:    'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

const TIER_PILL: Record<string, string> = {
  operate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  guided:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  managed: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  custom:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

const TYPE_LABEL: Record<string, string> = {
  news:  'News',
  nba:   'NBA',
  clips: 'Clips',
  nfl:   'NFL',
  twitch: 'Twitch',
};

// ── stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: { label: string; value: number | string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className={cn('text-2xl font-bold tabular-nums', accent)}>{value}</p>
      <p className="text-xs font-medium text-foreground mt-0.5">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

type Tab = 'feed' | 'accounts';

export default function AdminOverviewPage() {
  const router                = useRouter();
  const { isAdmin, isLoaded } = useRole();
  const { getToken }          = useAuth();

  const [data, setData]       = useState<ActivityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [lastFetch, setLast]  = useState<Date | null>(null);
  const [tab, setTab]         = useState<Tab>('feed');
  const [search, setSearch]   = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    if (isLoaded && !isAdmin) router.replace('/dashboard');
  }, [isLoaded, isAdmin, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res   = await getActivityOverview(token ?? undefined);
      setData(res);
      setLast(new Date());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (isLoaded && isAdmin) load();
  }, [isLoaded, isAdmin, load]);

  if (!isLoaded || !isAdmin) return null;

  const s = data?.stats;

  // ── filtered feed ─────────────────────────────────────────────────────────
  const filteredFeed: ActivityFeedItem[] = (data?.feed ?? []).filter((item) => {
    const matchStatus = statusFilter === 'all' || item.status === statusFilter;
    const q = search.toLowerCase();
    const matchSearch = !q ||
      item.email.toLowerCase().includes(q) ||
      (item.topic ?? '').toLowerCase().includes(q) ||
      item.contentType.toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  // ── filtered accounts ────────────────────────────────────────────────────
  const filteredAccounts: AccountActivity[] = (data?.accounts ?? []).filter((acc) => {
    const q = search.toLowerCase();
    return !q ||
      (acc.email ?? '').toLowerCase().includes(q) ||
      (acc.firstName ?? '').toLowerCase().includes(q) ||
      (acc.lastName  ?? '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6 max-w-7xl">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Platform Overview</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {lastFetch
              ? `Last updated ${lastFetch.toLocaleTimeString()}`
              : 'Global activity across all customer accounts'}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className={cn(
            'text-xs px-3 py-1.5 rounded border border-border transition-colors',
            'hover:bg-muted text-muted-foreground',
            loading && 'opacity-40 cursor-not-allowed',
          )}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</p>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard label="Total jobs"   value={s?.totalJobs ?? '—'} />
        <StatCard label="Running"      value={s?.running   ?? '—'} accent="text-blue-600 dark:text-blue-400" />
        <StatCard label="Complete"     value={s?.complete  ?? '—'} accent="text-emerald-600 dark:text-emerald-400" />
        <StatCard label="Published"    value={s?.published ?? '—'} accent="text-violet-600 dark:text-violet-400" />
        <StatCard label="Failed"       value={s?.failed    ?? '—'} accent="text-red-600 dark:text-red-400" />
        <StatCard label="Jobs (7d)"    value={s?.jobs7d    ?? '—'} sub="last 7 days" />
        <StatCard label="Accounts"     value={s?.accountsWithJobs ?? '—'} sub="with jobs" />
        <StatCard label="Credits (30d)" value={s?.credits30d?.toLocaleString() ?? '—'} sub="consumed" />
      </div>

      {/* Tabs + filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          {(['feed', 'accounts'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'px-3 py-1.5 text-sm rounded border transition-colors',
                tab === t
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t === 'feed' ? 'Activity Feed' : 'Accounts'}
            </button>
          ))}
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          <input
            type="text"
            placeholder={tab === 'feed' ? 'Filter by email or topic…' : 'Filter by email or name…'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 px-3 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary w-56"
          />
          {tab === 'feed' && (
            <div className="flex gap-1">
              {['all', 'running', 'complete', 'published', 'failed'].map((st) => (
                <button
                  key={st}
                  onClick={() => setStatusFilter(st)}
                  className={cn(
                    'px-2 py-1 text-xs rounded border transition-colors capitalize',
                    statusFilter === st
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {st}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Activity Feed tab ── */}
      {tab === 'feed' && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Account</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Type</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Topic</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredFeed.map((item) => (
                <tr
                  key={item.id}
                  className="hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => router.push(`/dashboard/operator?customerId=${item.customerId}`)}
                  title={`View ${item.email}'s account`}
                >
                  <td className="px-4 py-3">
                    <span className="font-medium text-foreground truncate max-w-[180px] block">
                      {item.email}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-muted-foreground">
                      {TYPE_LABEL[item.contentType] ?? item.contentType}
                    </span>
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <span className="text-muted-foreground truncate block" title={item.topic ?? ''}>
                      {item.topic ?? <span className="italic opacity-50">No topic</span>}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium', STATUS_PILL[item.status] ?? 'bg-muted text-muted-foreground')}>
                      <span className={cn('w-1.5 h-1.5 rounded-full', STATUS_DOT[item.status] ?? 'bg-slate-400')} />
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums">
                    {relTime(item.createdAt)}
                  </td>
                </tr>
              ))}
              {filteredFeed.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No activity matches the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Accounts tab ── */}
      {tab === 'accounts' && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Account</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Plan</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Total</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">7d</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Published</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Running</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Failed</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">Last active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredAccounts.map((acc) => {
                const name = [acc.firstName, acc.lastName].filter(Boolean).join(' ');
                return (
                  <tr
                    key={acc.customerId}
                    className="hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => router.push(`/dashboard/operator?customerId=${acc.customerId}`)}
                    title={`View ${acc.email ?? acc.customerId}'s account`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground truncate max-w-[200px]">
                        {acc.email ?? acc.customerId}
                      </div>
                      {name && <div className="text-xs text-muted-foreground">{name}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-block px-2 py-0.5 rounded text-xs font-medium', TIER_PILL[acc.planTier] ?? TIER_PILL.operate)}>
                        {tierLabel(acc.planTier)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">{acc.jobCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{acc.jobs7d || '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-violet-600 dark:text-violet-400">
                      {acc.publishedCount || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-blue-600 dark:text-blue-400">
                      {acc.runningCount || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-red-600 dark:text-red-400">
                      {acc.failedCount || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums">
                      {relTime(acc.lastJobAt)}
                    </td>
                  </tr>
                );
              })}
              {filteredAccounts.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No accounts match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Click any row to view that account in the operator view. &nbsp;·&nbsp;
        Showing most recent 50 jobs in the activity feed.
      </p>
    </div>
  );
}
