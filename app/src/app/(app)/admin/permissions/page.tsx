'use client';
/**
 * /admin/permissions — CPD-150
 *
 * Org permission management panel.
 * Shows all accounts with their members, roles, Clerk sync status.
 * Admin can change roles, sync Clerk metadata, and warp into customer sessions.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { tierLabel } from '@/lib/tier-labels';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Member {
  id: string;
  memberId: string | null;
  role: string;
  email: string | null;
  invitedEmail: string | null;
  status: string;
  clerkRole: string | null;
  syncOk: boolean | null;
  lastSignIn: number | null;
}

interface Account {
  accountId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  planTier: string;
  memberCount: number;
  members: Member[];
}

const ROLES = ['owner', 'admin', 'member', 'billing'];

const TIER_COLOR: Record<string, string> = {
  operate:    'bg-slate-100 text-slate-700',
  guided:    'bg-blue-100 text-blue-700',
  managed:    'bg-violet-100 text-violet-700',
  custom: 'bg-amber-100 text-amber-700',
};

function relTime(ts: number | null) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function PermissionsPage() {
  const { getToken } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch]     = useState('');
  const [working, setWorking]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await apiFetch<{ ok: boolean; accounts: Account[] }>('/admin/permissions', { token: token ?? undefined });
      setAccounts(res.accounts || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { load(); }, [load]);

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  async function changeRole(accountId: string, memberId: string, role: string) {
    const key = `${accountId}-${memberId}`;
    setWorking(key);
    try {
      const token = await getToken();
      await apiFetch(`/admin/permissions/${accountId}/member/${memberId}`, {
        method: 'PATCH',
        token: token ?? undefined,
        body: JSON.stringify({ role }),
      });
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to update role');
    } finally {
      setWorking(null);
    }
  }

  async function syncAccount(accountId: string) {
    setWorking(`sync-${accountId}`);
    try {
      const token = await getToken();
      const res = await apiFetch<{ ok: boolean; synced: number; failed: number }>(
        `/admin/permissions/${accountId}/sync`,
        { method: 'POST', token: token ?? undefined },
      );
      alert(`Synced ${res.synced} member(s) to Clerk. ${res.failed} failed.`);
      await load();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setWorking(null);
    }
  }

  async function warpInto(userId: string, email: string) {
    if (!confirm(`Enter session as ${email}? You will be signed in as them.`)) return;
    setWorking(`warp-${userId}`);
    try {
      const token = await getToken();
      const res = await apiFetch<{ ok: boolean; url: string }>(
        `/admin/warp/${userId}`,
        { method: 'POST', token: token ?? undefined },
      );
      if (res.url) window.location.href = res.url;
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Warp failed');
    } finally {
      setWorking(null);
    }
  }

  const filtered = accounts.filter((a) => {
    const q = search.toLowerCase();
    return !q || a.accountId.toLowerCase().includes(q) || (a.ownerEmail?.toLowerCase() || '').includes(q) || (a.ownerName?.toLowerCase() || '').includes(q);
  });

  if (loading) return (
    <div className="max-w-5xl space-y-4 animate-pulse">
      <div className="h-8 bg-muted rounded w-56" />
      {[1, 2, 3].map((i) => <div key={i} className="h-16 bg-muted rounded" />)}
    </div>
  );

  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Permission Management</h1>
        <p className="text-sm text-muted-foreground mt-1">
          All customer accounts, their team members, roles, and Clerk sync status.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-center justify-between text-sm text-destructive">
          {error}
          <button onClick={load} className="underline text-xs">Retry</button>
        </div>
      )}

      <input
        type="text"
        placeholder="Search by email or account ID…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
      />

      <div className="space-y-2">
        {filtered.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground text-center py-8">No accounts found.</p>
        )}
        {filtered.map((account) => {
          const isExpanded = expanded.has(account.accountId);
          const hasSync = account.members.some((m) => m.syncOk === false);

          return (
            <Card key={account.accountId} className="border-border">
              <CardHeader className="py-3 px-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={() => toggleExpanded(account.accountId)}
                    className="flex items-center gap-2 text-left flex-1 min-w-0"
                  >
                    <svg
                      className={cn('w-4 h-4 shrink-0 text-muted-foreground transition-transform', isExpanded && 'rotate-90')}
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {account.ownerName ?? account.ownerEmail ?? account.accountId}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{account.ownerEmail ?? account.accountId}</p>
                    </div>
                  </button>

                  <div className="flex items-center gap-2 shrink-0">
                    {hasSync && (
                      <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
                        Clerk out of sync
                      </span>
                    )}
                    <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', TIER_COLOR[account.planTier] ?? TIER_COLOR.diy)}>
                      {tierLabel(account.planTier)}
                    </span>
                    <span className="text-xs text-muted-foreground">{account.memberCount} member{account.memberCount !== 1 ? 's' : ''}</span>

                    {hasSync && (
                      <button
                        onClick={() => syncAccount(account.accountId)}
                        disabled={working === `sync-${account.accountId}`}
                        className="text-xs border border-border rounded px-2 py-0.5 hover:bg-accent/50 disabled:opacity-50"
                      >
                        {working === `sync-${account.accountId}` ? 'Syncing…' : 'Sync all'}
                      </button>
                    )}
                  </div>
                </div>
              </CardHeader>

              {isExpanded && (
                <CardContent className="pt-0 pb-4 px-4">
                  <div className="border-t border-border pt-3 space-y-2">
                    {account.members.map((m) => {
                      const wk = `${account.accountId}-${m.memberId}`;
                      return (
                        <div key={m.id} className="flex items-center gap-3 flex-wrap text-sm">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{m.email || m.invitedEmail || m.memberId || '—'}</p>
                            <p className="text-xs text-muted-foreground">
                              Last seen: {relTime(m.lastSignIn)}
                              {m.syncOk === false && (
                                <span className="ml-2 text-amber-600">
                                  · Clerk has <strong>{m.clerkRole || 'no role'}</strong>
                                </span>
                              )}
                            </p>
                          </div>

                          <Badge
                            variant="outline"
                            className={cn('text-xs', m.status === 'pending' && 'opacity-60')}
                          >
                            {m.status === 'pending' ? 'invited' : m.role}
                          </Badge>

                          {m.memberId && m.status === 'active' && (
                            <>
                              <select
                                value={m.role}
                                disabled={!!working}
                                onChange={(e) => changeRole(account.accountId, m.memberId!, e.target.value)}
                                className="text-xs border border-border rounded px-2 py-1 bg-background disabled:opacity-50"
                              >
                                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                              </select>

                              {m.role === 'owner' && (
                                <button
                                  onClick={() => warpInto(m.memberId!, m.email || account.accountId)}
                                  disabled={working === `warp-${m.memberId}`}
                                  className="text-xs border border-primary/40 text-primary rounded px-2 py-1 hover:bg-primary/5 disabled:opacity-50"
                                >
                                  {working === `warp-${m.memberId}` ? 'Opening…' : 'Enter as customer'}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
