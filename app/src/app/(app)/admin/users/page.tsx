'use client';
/**
 * /admin/users — Full Clerk user registry
 *
 * Every account that has ever signed up, regardless of DB activity.
 * Columns: email, name, plan, role, account setup, jobs, signed up,
 *          last login, last active, last job.
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';
import { listAllUsers, setUserRole, type AdminUser } from '@/lib/api';
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
  if (s < 86400 * 30) return `${Math.floor(s / 86400 / 7)}w ago`;
  return new Date(iso).toLocaleDateString();
}

function absTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const TIER_PILL: Record<string, string> = {
  operate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  guided:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  managed: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  custom:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

const ROLE_PILL: Record<string, string> = {
  superadmin: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  customer:   'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

type SortKey = 'signedUpAt' | 'lastSignInAt' | 'lastActiveAt' | 'lastJobAt' | 'jobCount';

export default function AdminUsersPage() {
  const router                = useRouter();
  const { isSuperAdmin, isLoaded } = useRole();
  const { getToken }          = useAuth();

  const [users, setUsers]       = useState<AdminUser[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [search, setSearch]     = useState('');
  const [tierFilter, setTierFilter] = useState('all');
  const [setupFilter, setSetupFilter] = useState<'all' | 'setup' | 'no-setup'>('all');
  const [sort, setSort]         = useState<SortKey>('signedUpAt');
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('desc');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [roleUpdating, setRoleUpdating] = useState<string | null>(null);
  const [roleError, setRoleError]       = useState<Record<string, string>>({});

  useEffect(() => {
    if (isLoaded && !isSuperAdmin) router.replace('/home');
  }, [isLoaded, isSuperAdmin, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res   = await listAllUsers(token ?? undefined);
      setUsers(res.users);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (isLoaded && isSuperAdmin) load();
  }, [isLoaded, isSuperAdmin, load]);

  if (!isLoaded || !isSuperAdmin) return null;

  // Filter
  const filtered = users.filter((u) => {
    if (tierFilter !== 'all' && u.planTier !== tierFilter) return false;
    if (setupFilter === 'setup'    && !u.hasAccount) return false;
    if (setupFilter === 'no-setup' &&  u.hasAccount) return false;
    const q = search.toLowerCase();
    if (!q) return true;
    return (
      (u.email     ?? '').toLowerCase().includes(q) ||
      (u.firstName ?? '').toLowerCase().includes(q) ||
      (u.lastName  ?? '').toLowerCase().includes(q) ||
      u.id.toLowerCase().includes(q)
    );
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    const av = a[sort];
    const bv = b[sort];
    if (av === null && bv === null) return 0;
    if (av === null) return sortDir === 'desc' ? 1 : -1;
    if (bv === null) return sortDir === 'desc' ? -1 : 1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'desc' ? -cmp : cmp;
  });

  async function handleRoleChange(userId: string, role: 'customer' | 'superadmin') {
    setRoleUpdating(userId);
    setRoleError((prev) => { const n = { ...prev }; delete n[userId]; return n; });
    try {
      const token = await getToken();
      await setUserRole(userId, role, token ?? undefined);
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role } : u));
    } catch (e: unknown) {
      setRoleError((prev) => ({ ...prev, [userId]: e instanceof Error ? e.message : 'Failed to update role' }));
    } finally {
      setRoleUpdating(null);
    }
  }

  function toggleSort(key: SortKey) {
    if (sort === key) setSortDir((d) => d === 'desc' ? 'asc' : 'desc');
    else { setSort(key); setSortDir('desc'); }
  }

  function SortTh({ k, children }: { k: SortKey; children: React.ReactNode }) {
    const active = sort === k;
    return (
      <th
        className="text-right px-4 py-2.5 af-subhead cursor-pointer select-none hover:text-foreground transition-colors"
        onClick={() => toggleSort(k)}
      >
        <span className="inline-flex items-center gap-1 justify-end">
          {children}
          <span className={cn('af-caption', active ? 'text-primary' : 'opacity-30')}>
            {active ? (sortDir === 'desc' ? '↓' : '↑') : '↕'}
          </span>
        </span>
      </th>
    );
  }

  // Summary counts
  const neverLoggedIn = users.filter((u) => !u.lastSignInAt).length;
  const noAccount     = users.filter((u) => !u.hasAccount).length;
  const activeToday   = users.filter((u) => {
    if (!u.lastSignInAt) return false;
    return Date.now() - new Date(u.lastSignInAt).getTime() < 86400000;
  }).length;

  return (
    <PageShell maxWidth="7xl">
      <PageHeader
        title="All Users"
        subtitle={loading ? 'Loading…' : `${sorted.length} of ${users.length} registered accounts`}
      >
        <button
          onClick={load}
          disabled={loading}
          className={cn(
            'af-caption px-3 py-1.5 rounded border border-border transition-colors',
            'hover:bg-muted text-muted-foreground',
            loading && 'opacity-40 cursor-not-allowed',
          )}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </PageHeader>

      {/* Summary tiles */}
      {!loading && users.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total registered',     value: users.length,   accent: '' },
            { label: 'Active today',         value: activeToday,    accent: 'text-success' },
            { label: 'No account setup',     value: noAccount,      accent: 'text-amber-600 dark:text-amber-400' },
            { label: 'Never logged back in', value: neverLoggedIn,  accent: '' },
          ].map((t) => (
            <div key={t.label} className="af-surface p-3">
              <p className={cn('af-metric tabular-nums', t.accent)}>{t.value}</p>
              <p className="af-caption mt-0.5">{t.label}</p>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</p>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Filter by email, name, or ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 px-3 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary w-72"
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
        <div className="flex gap-1">
          {([
            { v: 'all',      l: 'All' },
            { v: 'setup',    l: 'Setup complete' },
            { v: 'no-setup', l: 'No setup' },
          ] as const).map(({ v, l }) => (
            <button
              key={v}
              onClick={() => setSetupFilter(v)}
              className={cn(
                'px-2 py-1 text-xs rounded border transition-colors',
                setupFilter === v
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full af-body">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-4 py-2.5 af-subhead">User</th>
              <th className="text-left px-4 py-2.5 af-subhead">Plan / Role</th>
              <th className="text-left px-4 py-2.5 af-subhead">Setup</th>
              <SortTh k="jobCount">Jobs</SortTh>
              <SortTh k="signedUpAt">Signed up</SortTh>
              <SortTh k="lastSignInAt">Last login</SortTh>
              <SortTh k="lastActiveAt">Last active</SortTh>
              <SortTh k="lastJobAt">Last job</SortTh>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((u) => {
              const name      = [u.firstName, u.lastName].filter(Boolean).join(' ');
              const isExpanded = expandedId === u.id;
              return (
                <>
                  <tr
                    key={u.id}
                    className={cn(
                      'hover:bg-muted/30 transition-colors cursor-pointer',
                      isExpanded && 'bg-muted/20',
                    )}
                    onClick={() => setExpandedId(isExpanded ? null : u.id)}
                    title="Click to expand timestamps"
                  >
                    {/* User */}
                    <td className="px-4 py-3">
                      <div className="af-label font-medium truncate max-w-[220px]">
                        {name || u.email || <span className="text-muted-foreground italic">No name</span>}
                      </div>
                      {name && <div className="af-caption text-muted-foreground truncate">{u.email}</div>}
                    </td>

                    {/* Plan / Role */}
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className={cn('inline-block w-fit px-2 py-0.5 rounded af-caption font-medium', TIER_PILL[u.planTier] ?? TIER_PILL.operate)}>
                          {tierLabel(u.planTier)}
                        </span>
                        {u.role !== 'customer' && (
                          <span className={cn('inline-block w-fit px-2 py-0.5 rounded af-caption font-medium', ROLE_PILL[u.role] ?? ROLE_PILL.customer)}>
                            {u.role}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Account setup */}
                    <td className="px-4 py-3">
                      {u.hasAccount ? (
                        <span className="af-caption text-success font-medium">✓ Complete</span>
                      ) : (
                        <span className="af-caption text-amber-600 dark:text-amber-400">Not set up</span>
                      )}
                    </td>

                    {/* Jobs */}
                    <td className="px-4 py-3 text-right tabular-nums af-label font-medium">
                      {u.jobCount || <span className="text-muted-foreground">—</span>}
                    </td>

                    {/* Signed up */}
                    <td className="px-4 py-3 text-right af-caption tabular-nums">
                      {isExpanded ? absTime(u.signedUpAt) : relTime(u.signedUpAt)}
                    </td>

                    {/* Last login */}
                    <td className="px-4 py-3 text-right af-caption tabular-nums">
                      {u.lastSignInAt ? (
                        <span className={cn(
                          Date.now() - new Date(u.lastSignInAt).getTime() < 86400000
                            ? 'text-success'
                            : 'text-muted-foreground',
                        )}>
                          {isExpanded ? absTime(u.lastSignInAt) : relTime(u.lastSignInAt)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50 italic">never</span>
                      )}
                    </td>

                    {/* Last active */}
                    <td className="px-4 py-3 text-right af-caption tabular-nums">
                      {isExpanded ? absTime(u.lastActiveAt) : relTime(u.lastActiveAt)}
                    </td>

                    {/* Last job */}
                    <td className="px-4 py-3 text-right af-caption tabular-nums">
                      {isExpanded ? absTime(u.lastJobAt) : relTime(u.lastJobAt)}
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {isExpanded && (
                    <tr key={`${u.id}-detail`} className="bg-muted/10 border-t-0">
                      <td colSpan={8} className="px-4 pb-3 pt-0">
                        <div className="flex flex-wrap gap-x-8 gap-y-2 af-caption">
                          <span><span className="font-medium text-foreground">Signed up</span> — {absTime(u.signedUpAt)}</span>
                          <span><span className="font-medium text-foreground">Last login</span> — {absTime(u.lastSignInAt)}</span>
                          <span><span className="font-medium text-foreground">Last active</span> — {absTime(u.lastActiveAt)}</span>
                          <span><span className="font-medium text-foreground">Last job</span> — {absTime(u.lastJobAt)}</span>
                          <span><span className="font-medium text-foreground">Clerk ID</span> — <span className="font-mono">{u.id}</span></span>
                          {u.hasAccount && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); router.push(`/operator?customerId=${u.id}`); }}
                              className="text-primary hover:underline font-medium"
                            >
                              View operator account →
                            </button>
                          )}
                        </div>

                        {/* Role assignment */}
                        <div className="mt-2 flex items-center gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
                          <span className="font-medium text-foreground af-caption">Role:</span>
                          {(['customer', 'superadmin'] as const).map((r) => (
                            <button
                              key={r}
                              disabled={roleUpdating === u.id}
                              onClick={() => handleRoleChange(u.id, r)}
                              className={cn(
                                'px-2.5 py-0.5 rounded af-caption font-medium border transition-colors capitalize',
                                u.role === r
                                  ? cn(ROLE_PILL[r], 'border-current opacity-100')
                                  : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground',
                                roleUpdating === u.id && 'opacity-40 cursor-not-allowed',
                              )}
                            >
                              {r}
                            </button>
                          ))}
                          {roleUpdating === u.id && (
                            <span className="af-caption text-muted-foreground">Saving…</span>
                          )}
                          {roleError[u.id] && (
                            <span className="af-caption text-destructive">{roleError[u.id]}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {sorted.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center af-body">
                  No users match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="af-caption">
        Click any row to expand full timestamps and Clerk ID. &nbsp;·&nbsp;
        Sortable by signed up, last login, last active, last job, and job count.
      </p>
    </PageShell>
  );
}
