'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';
import { listCustomers, type CustomerRecord } from '@/lib/api';
import { tierLabel } from '@/lib/tier-labels';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)        return 'just now';
  if (s < 3600)      return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)     return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

const TIER_PILL: Record<string, string> = {
  operate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  guided:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  managed: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  custom:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

export default function AdminCustomersPage() {
  const router                = useRouter();
  const { isSuperAdmin, isLoaded } = useRole();
  const { getToken }          = useAuth();

  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [search, setSearch]       = useState('');
  const [tierFilter, setTierFilter] = useState('all');

  useEffect(() => {
    if (isLoaded && !isSuperAdmin) router.replace('/home');
  }, [isLoaded, isSuperAdmin, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res   = await listCustomers(token ?? undefined);
      setCustomers(res.customers);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (isLoaded && isSuperAdmin) load();
  }, [isLoaded, isSuperAdmin, load]);

  if (!isLoaded || !isSuperAdmin) return null;

  const filtered = customers.filter((c) => {
    const matchTier = tierFilter === 'all' || c.planTier === tierFilter;
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (c.email ?? '').toLowerCase().includes(q) ||
      (c.firstName ?? '').toLowerCase().includes(q) ||
      (c.lastName  ?? '').toLowerCase().includes(q);
    return matchTier && matchSearch;
  });

  return (
    <PageShell maxWidth="6xl">
      <PageHeader
        title="All Customers"
        subtitle={loading ? 'Loading…' : `${filtered.length} of ${customers.length} accounts`}
      >
        <button
          onClick={load}
          disabled={loading}
          className={cn(
            'af-label px-3 py-1.5 rounded border border-border transition-colors',
            'hover:bg-muted',
            loading && 'opacity-40 cursor-not-allowed',
          )}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </PageHeader>

      {error && (
        <p className="af-body text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Filter by email or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 px-3 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary w-64"
        />
        <div className="flex gap-1">
          {(['all', 'operate', 'guided', 'managed', 'custom'] as const).map((tier) => (
            <button
              key={tier}
              onClick={() => setTierFilter(tier)}
              className={cn(
                'px-2 py-1 text-xs rounded border transition-colors capitalize',
                tierFilter === tier
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {tier === 'all' ? 'All plans' : tierLabel(tier)}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-4 py-2.5 af-subhead">Account</th>
              <th className="text-left px-4 py-2.5 af-subhead">Plan</th>
              <th className="text-right px-4 py-2.5 af-subhead">Credits</th>
              <th className="text-right px-4 py-2.5 af-subhead">Jobs</th>
              <th className="text-right px-4 py-2.5 af-subhead">Last login</th>
              <th className="text-right px-4 py-2.5 af-subhead">Last job</th>
              <th className="text-right px-4 py-2.5 af-subhead">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((c) => {
              const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
              return (
                <tr
                  key={c.id}
                  className="hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => router.push(`/operator?customerId=${c.id}`)}
                  title={`View ${c.email ?? c.id}'s jobs`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground truncate max-w-[220px]">
                      {c.email ?? c.id}
                    </div>
                    {name && <div className="text-xs text-muted-foreground">{name}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-block px-2 py-0.5 rounded text-xs font-medium', TIER_PILL[c.planTier] ?? TIER_PILL.operate)}>
                      {tierLabel(c.planTier)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {c.credits ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {c.jobCount}
                  </td>
                  <td className="px-4 py-3 text-right text-xs tabular-nums">
                    <span className={c.lastSignInAt ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                      {relTime(c.lastSignInAt)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums">
                    {relTime(c.lastJobAt)}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums">
                    {relTime(c.createdAt)}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center af-body text-muted-foreground">
                  No customers match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </PageShell>
  );
}
