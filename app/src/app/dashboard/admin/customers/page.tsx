'use client';
/**
 * /dashboard/admin/customers — Superuser customer accounts view (CPD-131)
 *
 * Admin-only. Lists every Clerk user with their plan tier, credit balance,
 * job count, and last activity. Allows drilling into a customer's jobs.
 */

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import { listCustomers, type CustomerRecord, type PlanTier } from '@/lib/api';
import { tierLabel } from '@/lib/tier-labels';
import { useRole } from '@/hooks/use-role';

const TIER_COLORS: Record<PlanTier | string, string> = {
  operate:    'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  guided:    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  managed:    'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  custom: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

const ROLE_COLORS: Record<string, string> = {
  admin:    'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  operator: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  customer: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  if (mins < 60)    return `${mins}m ago`;
  const hrs  = Math.floor(mins / 60);
  if (hrs  < 24)    return `${hrs}h ago`;
  const days = Math.floor(hrs  / 24);
  if (days < 30)    return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function AdminCustomersPage() {
  const router                   = useRouter();
  const { isAdmin, isLoaded }    = useRole();
  const { getToken }             = useAuth();

  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [isPending, start]        = useTransition();
  const [error, setError]         = useState<string | null>(null);
  const [search, setSearch]       = useState('');
  const [tierFilter, setTierFilter] = useState<PlanTier | 'all'>('all');
  const [lastFetch, setLast]      = useState<Date | null>(null);

  useEffect(() => {
    if (isLoaded && !isAdmin) router.replace('/dashboard');
  }, [isLoaded, isAdmin, router]);

  async function fetchCustomers() {
    start(async () => {
      try {
        const token = await getToken();
        const res = await listCustomers(token ?? undefined);
        setCustomers(res.customers ?? []);
        setLast(new Date());
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load customers');
      }
    });
  }

  useEffect(() => {
    if (isLoaded && isAdmin) fetchCustomers();
  }, [isLoaded, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isLoaded || !isAdmin) return null;

  const TIERS: Array<PlanTier | 'all'> = ['all', 'operate', 'guided', 'managed', 'custom'];
  const TIER_DISPLAY: Record<string, string> = { all: 'All', operate: 'Operate', guided: 'Guided', managed: 'Managed', custom: 'Custom' };

  const filtered = customers.filter((c) => {
    const matchesTier   = tierFilter === 'all' || c.planTier === tierFilter;
    const q             = search.toLowerCase();
    const matchesSearch = !q ||
      (c.email  || '').toLowerCase().includes(q) ||
      (c.firstName || '').toLowerCase().includes(q) ||
      (c.lastName  || '').toLowerCase().includes(q);
    return matchesTier && matchesSearch;
  });

  const metrics = {
    total:    customers.length,
    operate:  customers.filter((c) => c.planTier === 'operate').length,
    guided:   customers.filter((c) => c.planTier === 'guided').length,
    managed:  customers.filter((c) => c.planTier === 'managed').length,
    custom:   customers.filter((c) => c.planTier === 'custom').length,
    withJobs: customers.filter((c) => c.jobCount > 0).length,
  };

  return (
    <div className="space-y-5 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Customer Accounts</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {lastFetch ? `Updated ${lastFetch.toLocaleTimeString()}` : 'Superuser view — all accounts'}
          </p>
        </div>
        <button
          onClick={fetchCustomers}
          disabled={isPending}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), isPending && 'opacity-50')}
        >
          {isPending ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {(Object.entries(metrics) as [string, number][]).map(([key, val]) => (
          <Card key={key} className="text-center py-2">
            <CardContent className="p-0">
              <p className="text-xl font-semibold">{val}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{key}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="text"
          placeholder="Search by email or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 px-3 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary w-64"
        />
        <div className="flex gap-1">
          {TIERS.map((t) => (
            <button
              key={t}
              onClick={() => setTierFilter(t)}
              className={cn(
                'px-2.5 py-1 text-xs rounded border transition-colors',
                tierFilter === t
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {TIER_DISPLAY[t] ?? t}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">Account</th>
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">Role</th>
              <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">Plan</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">Credits</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">Jobs</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">Last Job</th>
              <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((c) => {
              const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || null;
              return (
                <tr
                  key={c.id}
                  className="hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => router.push(`/dashboard/operator?customerId=${c.id}`)}
                  title={`View jobs for ${c.email || c.id}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground truncate max-w-[220px]">{c.email || c.id}</div>
                    {name && <div className="text-xs text-muted-foreground truncate">{name}</div>}
                    <div className="text-[10px] text-muted-foreground/60 font-mono">{c.id.slice(-8)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-block px-2 py-0.5 rounded text-xs font-medium', ROLE_COLORS[c.role] || ROLE_COLORS.customer)}>
                      {c.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-block px-2 py-0.5 rounded text-xs font-medium', TIER_COLORS[c.planTier] || TIER_COLORS.diy)}>
                      {tierLabel(c.planTier)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {c.credits !== null ? c.credits.toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {c.jobCount > 0 ? c.jobCount : <span className="text-muted-foreground">0</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                    {relativeTime(c.lastJobAt)}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                    {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && !isPending && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No customers match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Click any row to view that customer&apos;s jobs in the operator view.
        Full account impersonation (see their dashboard as them) is planned for a future release.
      </p>
    </div>
  );
}
