'use client';
/**
 * /admin/crm — CPD-154
 *
 * Internal CRM — list of all customer accounts with summary metrics.
 * Search, filter, and click-through to the full account detail view.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { tierLabel } from '@/lib/tier-labels';

interface AccountSummary {
  accountId:    string;
  ownerEmail:   string | null;
  planTier:     string;
  creditsLeft:  number | null;
  jobCount:     number;
  lastActivity: string | null;
}

const TIER_BADGE: Record<string, string> = {
  operate:    'bg-slate-100 text-slate-700',
  guided:    'bg-blue-100 text-blue-700',
  managed:    'bg-violet-100 text-violet-700',
  custom: 'bg-amber-100 text-amber-700',
};

function relTime(iso: string | null) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function CrmListPage() {
  const { getToken }           = useAuth();
  const router                 = useRouter();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading]  = useState(true);
  const [error, setError]      = useState<string | null>(null);
  const [search, setSearch]    = useState('');
  const [tierFilter, setTierFilter] = useState('all');
  const [sortBy, setSortBy]    = useState<'lastActivity' | 'jobCount' | 'creditsLeft'>('lastActivity');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await apiFetch<{ ok: boolean; accounts: AccountSummary[] }>(
        '/admin/crm',
        { token: token ?? undefined },
      );
      setAccounts(res.accounts || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { load(); }, [load]);

  const filtered = accounts
    .filter((a) => {
      if (tierFilter !== 'all' && a.planTier !== tierFilter) return false;
      const q = search.toLowerCase();
      return !q || (a.ownerEmail?.toLowerCase() || '').includes(q) || a.accountId.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (sortBy === 'jobCount') return (b.jobCount || 0) - (a.jobCount || 0);
      if (sortBy === 'creditsLeft') return (b.creditsLeft ?? -1) - (a.creditsLeft ?? -1);
      return new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime();
    });

  if (loading) return (
    <div className="max-w-6xl space-y-4 animate-pulse">
      <div className="h-8 bg-muted rounded w-40" />
      <div className="h-10 bg-muted rounded" />
      {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-12 bg-muted rounded" />)}
    </div>
  );

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">CRM</h1>
          <p className="text-sm text-muted-foreground mt-1">
            All customer accounts — {accounts.length} total
          </p>
        </div>
        <button
          onClick={load}
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground border border-border rounded px-3 py-1.5"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-center justify-between text-sm text-destructive">
          {error}
          <button onClick={load} className="underline text-xs">Retry</button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          placeholder="Search email or account ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-48 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="all">All plans</option>
          <option value="operate">Operate</option>
          <option value="guided">Guided</option>
          <option value="managed">Managed</option>
          <option value="custom">Enterprise</option>
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="lastActivity">Sort: Last activity</option>
          <option value="jobCount">Sort: Job count</option>
          <option value="creditsLeft">Sort: Credits left</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 border-b border-border">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Account</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Plan</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Credits left</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Jobs</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Last active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No accounts match the current filters.
                </td>
              </tr>
            ) : filtered.map((a) => (
              <tr
                key={a.accountId}
                onClick={() => router.push(`/admin/crm/${a.accountId}`)}
                className="hover:bg-accent/30 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3">
                  <p className="font-medium truncate max-w-xs">{a.ownerEmail ?? '—'}</p>
                  <p className="text-xs text-muted-foreground font-mono">{a.accountId.slice(0, 18)}…</p>
                </td>
                <td className="px-4 py-3">
                  <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', TIER_BADGE[a.planTier] ?? TIER_BADGE.operate)}>
                    {tierLabel(a.planTier)}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {a.creditsLeft === null ? '—' : a.creditsLeft.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{a.jobCount}</td>
                <td className="px-4 py-3 text-right text-muted-foreground">{relTime(a.lastActivity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Showing {filtered.length} of {accounts.length} accounts
      </p>
    </div>
  );
}
