'use client';
/**
 * /admin/crm/[accountId] — CPD-154
 *
 * Full account record — tabbed layout showing all data sections.
 * Operator can view. Admin can change plan, adjust credits, and warp in.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { tierLabel } from '@/lib/tier-labels';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

type Tab = 'overview' | 'jobs' | 'templates' | 'publish' | 'team' | 'billing' | 'support' | 'notes';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',  label: 'Overview'  },
  { id: 'jobs',      label: 'Jobs'      },
  { id: 'templates', label: 'Templates' },
  { id: 'publish',   label: 'Publish'   },
  { id: 'team',      label: 'Team'      },
  { id: 'billing',   label: 'Billing'   },
  { id: 'support',   label: 'Support'   },
  { id: 'notes',     label: 'Notes'     },
];

function relTime(iso: string | number | null | undefined) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso as string).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const STATUS_COLOR: Record<string, string> = {
  complete:   'bg-green-100 text-green-700',
  published:  'bg-green-100 text-green-700',
  running:    'bg-blue-100 text-blue-700',
  pending:    'bg-slate-100 text-slate-600',
  failed:     'bg-red-100 text-red-700',
  error:      'bg-red-100 text-red-700',
};

export default function CrmAccountPage() {
  const { getToken }         = useAuth();
  const { accountId }        = useParams<{ accountId: string }>();
  const router               = useRouter();
  const [tab, setTab]        = useState<Tab>('overview');
  const [data, setData]      = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]    = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [noteBody, setNoteBody] = useState('');
  const [planInput, setPlanInput] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string; description: string; confirmLabel?: string; destructive?: boolean; onConfirm: () => void;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await apiFetch<Record<string, unknown>>(`/admin/crm/${accountId}`, { token: token ?? undefined });
      setData(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [getToken, accountId]);

  useEffect(() => { load(); }, [load]);

  function handleWarp() {
    const identity = data?.identity as Record<string, unknown> | null;
    const email = identity?.email as string || accountId;
    setConfirmDialog({
      title: 'Enter as customer',
      description: `You will be signed in as ${email}. This is an admin action.`,
      confirmLabel: 'Enter session',
      onConfirm: () => {
        setConfirmDialog(null);
        void (async () => {
          setWorking(true);
          try {
            const token = await getToken();
            const res = await apiFetch<{ ok: boolean; url: string }>(
              `/admin/warp/${accountId}`,
              { method: 'POST', token: token ?? undefined },
            );
            if (res.url) window.location.href = res.url;
          } catch (e: unknown) {
            setActionError(e instanceof Error ? e.message : 'Warp failed');
          } finally {
            setWorking(false);
          }
        })();
      },
    });
  }

  function handlePlanChange() {
    if (!planInput) return;
    setConfirmDialog({
      title: 'Change plan',
      description: `Change this account's plan to ${planInput}?`,
      confirmLabel: 'Apply plan',
      onConfirm: () => {
        setConfirmDialog(null);
        void (async () => {
          setWorking(true);
          try {
            const token = await getToken();
            await apiFetch(`/admin/crm/${accountId}/plan`, {
              method: 'PATCH',
              token: token ?? undefined,
              body: JSON.stringify({ tier: planInput }),
            });
            await load();
            setPlanInput('');
          } catch (e: unknown) {
            setActionError(e instanceof Error ? e.message : 'Plan change failed');
          } finally {
            setWorking(false);
          }
        })();
      },
    });
  }

  function handleCreditAdjust() {
    const amount = Number(creditAmount);
    if (!amount) return;
    setConfirmDialog({
      title: `${amount > 0 ? 'Grant' : 'Deduct'} credits`,
      description: `${amount > 0 ? 'Grant' : 'Deduct'} ${Math.abs(amount)} credits ${amount > 0 ? 'to' : 'from'} this account?`,
      confirmLabel: amount > 0 ? 'Grant credits' : 'Deduct credits',
      onConfirm: () => {
        setConfirmDialog(null);
        void (async () => {
          setWorking(true);
          try {
            const token = await getToken();
            await apiFetch(`/admin/crm/${accountId}/credits`, {
              method: 'POST',
              token: token ?? undefined,
              body: JSON.stringify({ amount }),
            });
            await load();
            setCreditAmount('');
          } catch (e: unknown) {
            setActionError(e instanceof Error ? e.message : 'Credit adjust failed');
          } finally {
            setWorking(false);
          }
        })();
      },
    });
  }

  async function handleAddNote() {
    if (!noteBody.trim()) return;
    setWorking(true);
    try {
      const token = await getToken();
      await apiFetch(`/admin/crm/${accountId}/notes`, {
        method: 'POST',
        token: token ?? undefined,
        body: JSON.stringify({ body: noteBody }),
      });
      setNoteBody('');
      await load();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Failed to add note');
    } finally {
      setWorking(false);
    }
  }

  if (loading) return (
    <div className="max-w-4xl space-y-4 animate-pulse">
      <div className="h-6 bg-muted rounded w-32" />
      <div className="h-24 bg-muted rounded" />
      <div className="h-64 bg-muted rounded" />
    </div>
  );

  if (error || !data) return (
    <div className="max-w-4xl space-y-4">
      <button onClick={() => router.back()} className="text-xs text-muted-foreground hover:text-foreground">← Back</button>
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {error || 'No data'}
        <button onClick={load} className="ml-4 underline text-xs">Retry</button>
      </div>
    </div>
  );

  const identity  = data.identity  as Record<string, unknown> | null;
  const plan      = data.plan      as Record<string, unknown> | null;
  const credits   = data.credits   as Record<string, unknown> | null;
  const jobs      = data.jobs      as { totalCount: number; items: Record<string, unknown>[] };
  const templates = data.templates as { count: number; items: Record<string, unknown>[] };
  const publish   = data.publishHistory as Record<string, unknown>[];
  const team      = data.team      as Record<string, unknown>[];
  const support   = data.support   as Record<string, unknown>[];
  const notes     = data.notes     as Record<string, unknown>[];

  const ownerEmail = identity?.email as string || null;
  const ownerName  = [identity?.firstName, identity?.lastName].filter(Boolean).join(' ') || ownerEmail || accountId;

  return (
    <div className="max-w-4xl space-y-5">
      {/* Breadcrumb */}
      <button onClick={() => router.push('/admin/crm')} className="text-xs text-muted-foreground hover:text-foreground">
        ← CRM
      </button>

      {actionError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive flex items-center justify-between">
          {actionError}
          <button onClick={() => setActionError(null)} className="ml-4 text-xs underline">Dismiss</button>
        </div>
      )}

      {/* Account header */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold">{ownerName}</h1>
            {ownerEmail && <p className="text-xs text-muted-foreground mt-0.5">{ownerEmail}</p>}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium',
                plan?.planTier === 'custom' ? 'bg-amber-100 text-amber-700' :
                plan?.planTier === 'managed'    ? 'bg-violet-100 text-violet-700' :
                plan?.planTier === 'guided'    ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700',
              )}>
                {tierLabel(plan?.planTier as string || 'operate')}
              </span>
              <span className="text-xs text-muted-foreground">
                {credits?.totalRemaining != null ? `${(credits.totalRemaining as number).toLocaleString()} credits left` : '—'}
              </span>
              <span className="text-xs text-muted-foreground">
                {team?.length ?? 0} member{team?.length !== 1 ? 's' : ''}
              </span>
              <span className="text-xs text-muted-foreground">
                {jobs?.totalCount ?? 0} jobs
              </span>
              {Boolean(identity?.lastSignIn) && (
                <span className="text-xs text-muted-foreground">
                  Last sign-in: {relTime(identity?.lastSignIn as string)}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={handleWarp}
            disabled={working}
            className="shrink-0 text-xs border border-primary/40 text-primary rounded px-3 py-1.5 hover:bg-primary/5 disabled:opacity-50"
          >
            Enter as customer
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'shrink-0 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                tab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Plan</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Tier</span>
                <span>{tierLabel(plan?.planTier as string || 'operate')}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Stripe status</span>
                <span>{plan?.stripeStatus as string || '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Renews</span>
                <span>{plan?.currentPeriodEnd ? new Date(plan.currentPeriodEnd as string).toLocaleDateString() : '—'}</span>
              </div>
              <div className="pt-2 border-t border-border flex gap-2">
                <select
                  value={planInput}
                  onChange={(e) => setPlanInput(e.target.value)}
                  className="flex-1 text-xs border border-border rounded px-2 py-1 bg-background"
                >
                  <option value="">Change plan…</option>
                  <option value="operate">Operate</option>
                  <option value="guided">Guided</option>
                  <option value="managed">Managed</option>
                  <option value="custom">Enterprise</option>
                </select>
                <button
                  onClick={handlePlanChange}
                  disabled={!planInput || working}
                  className="text-xs border border-border rounded px-2 py-1 hover:bg-accent/50 disabled:opacity-40"
                >
                  Apply
                </button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Credits</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Included left</span>
                <span className="tabular-nums">{(credits?.includedRemaining as number)?.toLocaleString() ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Pack credits</span>
                <span className="tabular-nums">{(credits?.packCreditsRemaining as number)?.toLocaleString() ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Period</span>
                <span className="text-xs">
                  {credits?.billingPeriodStart ? new Date(credits.billingPeriodStart as string).toLocaleDateString() : '—'}
                  {' → '}
                  {credits?.billingPeriodEnd ? new Date(credits.billingPeriodEnd as string).toLocaleDateString() : '—'}
                </span>
              </div>
              <div className="pt-2 border-t border-border flex gap-2">
                <input
                  type="number"
                  value={creditAmount}
                  onChange={(e) => setCreditAmount(e.target.value)}
                  placeholder="±credits"
                  className="flex-1 text-xs border border-border rounded px-2 py-1 bg-background"
                />
                <button
                  onClick={handleCreditAdjust}
                  disabled={!creditAmount || working}
                  className="text-xs border border-border rounded px-2 py-1 hover:bg-accent/50 disabled:opacity-40"
                >
                  Adjust
                </button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === 'jobs' && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Job ID</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Type</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Platforms</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {jobs?.items?.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">No jobs yet.</td></tr>
              ) : jobs?.items?.map((j) => (
                <tr key={j.id as string}>
                  <td className="px-4 py-2">
                    <p className="font-mono text-xs">{(j.id as string)?.slice(0, 8)}…</p>
                    {Boolean(j.outputUrl) && <a href={j.outputUrl as string} target="_blank" rel="noreferrer" className="text-xs text-primary underline">Output</a>}
                  </td>
                  <td className="px-4 py-2 text-xs">{j.contentType as string}</td>
                  <td className="px-4 py-2">
                    <span className={cn('text-xs px-1.5 py-0.5 rounded', STATUS_COLOR[j.status as string] ?? 'bg-muted text-muted-foreground')}>
                      {j.status as string}
                    </span>
                    {Boolean(j.failReason) && <p className="text-xs text-red-600 mt-0.5 max-w-xs truncate">{j.failReason as string}</p>}
                  </td>
                  <td className="px-4 py-2 text-xs">{((j.platforms as string[]) || []).join(', ') || '—'}</td>
                  <td className="px-4 py-2 text-right text-xs text-muted-foreground">{relTime(j.createdAt as string)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'templates' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {templates?.items?.length === 0 ? (
            <p className="text-sm text-muted-foreground col-span-2 py-6 text-center">No templates saved.</p>
          ) : templates?.items?.map((t) => (
            <Card key={t.id as string}>
              <CardContent className="py-3 px-4 text-sm">
                <p className="font-medium">{t.name as string}</p>
                <p className="text-xs text-muted-foreground">
                  {t.contentType as string} · {((t.platforms as string[]) || []).join(', ') || '—'}
                  {Boolean(t.recurrenceType) && ` · ${t.recurrenceType as string}`}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {tab === 'publish' && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Platform</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Link</th>
                <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">Published</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {publish?.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">No publish history.</td></tr>
              ) : publish?.map((p, i) => (
                <tr key={i}>
                  <td className="px-4 py-2 capitalize text-xs">{p.platform as string}</td>
                  <td className="px-4 py-2">
                    <span className={cn('text-xs px-1.5 py-0.5 rounded', STATUS_COLOR[p.status as string] ?? 'bg-muted text-muted-foreground')}>
                      {p.status as string}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {p.driveUrl ? <a href={p.driveUrl as string} target="_blank" rel="noreferrer" className="text-primary underline">View</a> : '—'}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-muted-foreground">{relTime(p.publishedAt as string)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'team' && (
        <div className="space-y-2">
          {team?.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No team members.</p>
          ) : team?.map((m) => (
            <div key={m.id as string} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{m.email as string || m.memberId as string || '—'}</p>
                <p className="text-xs text-muted-foreground">Joined {relTime(m.joinedAt as string)}</p>
              </div>
              <Badge variant="outline" className="text-xs">{m.role as string}</Badge>
              <span className={cn('text-xs', m.status === 'active' ? 'text-green-600' : 'text-muted-foreground')}>{m.status as string}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'billing' && (
        <Card>
          <CardContent className="py-4 px-4 space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Plan tier</span><span>{tierLabel(plan?.planTier as string || 'operate')}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Stripe sub ID</span><span className="text-xs font-mono">{plan?.stripeSubscriptionId as string || '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Stripe status</span><span>{plan?.stripeStatus as string || '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Period end</span><span>{plan?.currentPeriodEnd ? new Date(plan.currentPeriodEnd as string).toLocaleDateString() : '—'}</span></div>
          </CardContent>
        </Card>
      )}

      {tab === 'support' && (
        <div className="space-y-2">
          {support?.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No support messages.</p>
          ) : support?.map((m, i) => (
            <div key={i} className={cn('rounded-lg border px-4 py-3 text-sm', m.role === 'user' ? 'border-border' : 'border-border bg-muted/20')}>
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="text-xs">{m.role as string}</Badge>
                <span className="text-xs text-muted-foreground">{m.channel as string}</span>
                <span className="text-xs text-muted-foreground ml-auto">{relTime(m.sentAt as string)}</span>
              </div>
              <p className="text-sm">{m.content as string}</p>
            </div>
          ))}
        </div>
      )}

      {tab === 'notes' && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <textarea
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Add an internal operator note…"
              rows={3}
              className="flex-1 text-sm border border-border rounded-md px-3 py-2 bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              onClick={handleAddNote}
              disabled={!noteBody.trim() || working}
              className="shrink-0 self-end text-xs border border-border rounded px-3 py-2 hover:bg-accent/50 disabled:opacity-40"
            >
              Add note
            </button>
          </div>

          <div className="space-y-2">
            {notes?.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No notes yet.</p>
            ) : notes?.map((n) => (
              <div key={n.id as string} className="rounded-lg border border-border px-4 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-muted-foreground font-mono">{(n.authorId as string)?.slice(0, 12)}…</span>
                  <span className="text-xs text-muted-foreground ml-auto">{relTime(n.createdAt as string)}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{n.body as string}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmDialog && (
        <ConfirmDialog
          open={true}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel}
          destructive={confirmDialog.destructive}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}
