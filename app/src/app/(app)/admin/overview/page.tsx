'use client';
/**
 * /admin — CPD-177
 *
 * Superuser command centre: platform-wide activity, account stats, and recent
 * job feed across all customer accounts. Admin role only.
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';
import { EngineHexagon } from '@/components/icons/brand-icons';
import {
  getActivityOverview, type ActivityOverview, type ActivityFeedItem, type AccountActivity,
  getSystemHealth,     type SystemHealth, type RenderService, type NrIncident,
} from '@/lib/api';
import { tierLabel } from '@/lib/tier-labels';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

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
    <div className="af-surface p-4">
      <p className={cn('af-metric', accent)}>{value}</p>
      <p className="af-label font-medium text-foreground mt-0.5">{label}</p>
      {sub && <p className="af-caption mt-0.5">{sub}</p>}
    </div>
  );
}

// ── service health helpers ─────────────────────────────────────────────────────

const DEPLOY_BADGE: Record<string, string> = {
  live:              'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  build_in_progress:'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  build_failed:      'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  deactivated:       'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  canceled:          'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

const PRIORITY_BADGE: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  HIGH:     'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  MEDIUM:   'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  LOW:      'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

function ServiceCard({ svc }: { svc: RenderService }) {
  const deploy    = svc.deploy;
  const status    = deploy?.status ?? 'unknown';
  const isFailed  = status === 'build_failed';
  const isLive    = status === 'live';
  const isSuspended = svc.suspended === 'suspended';

  return (
    <div className={cn(
      'rounded-lg border p-4 space-y-2',
      isFailed ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30'
      : isSuspended ? 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/30'
      : 'border-border bg-card',
    )}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn(
            'w-2.5 h-2.5 rounded-full flex-shrink-0',
            isFailed ? 'bg-red-500' : isSuspended ? 'bg-slate-400' : isLive ? 'bg-emerald-500' : 'bg-blue-400 animate-pulse',
          )} />
          <span className="font-medium text-sm">{svc.name}</span>
          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{svc.type}</span>
        </div>
        {!isSuspended && (
          <span className={cn('text-xs px-2 py-0.5 rounded font-medium', DEPLOY_BADGE[status] ?? 'bg-muted text-muted-foreground')}>
            {status.replace(/_/g, ' ')}
          </span>
        )}
        {isSuspended && (
          <span className="text-xs px-2 py-0.5 rounded font-medium bg-slate-100 text-slate-500 dark:bg-slate-800">suspended</span>
        )}
      </div>
      {deploy && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {deploy.commit && <p className="truncate" title={deploy.commit}>{deploy.commit}</p>}
          {deploy.finishedAt && <p>{relTime(deploy.finishedAt)}</p>}
        </div>
      )}
    </div>
  );
}

function MetricBox({ label, value, sub, warn }: { label: string; value: string | number | null; sub?: string; warn?: boolean }) {
  return (
    <div className="af-surface p-3 text-center">
      <p className={cn('text-lg font-bold tabular-nums', warn ? 'text-red-400' : '')}>{value ?? '—'}</p>
      <p className="af-caption">{label}</p>
      {sub && <p className="af-caption opacity-70">{sub}</p>}
    </div>
  );
}

function IncidentCard({ inc }: { inc: NrIncident }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30 px-4 py-3 flex items-start gap-3">
      <span className="mt-0.5 w-2 h-2 rounded-full bg-red-500 flex-shrink-0 animate-pulse" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', PRIORITY_BADGE[inc.priority] ?? PRIORITY_BADGE.LOW)}>
            {inc.priority}
          </span>
          <span className="font-medium text-sm text-foreground">{inc.title}</span>
        </div>
        {inc.entityNames?.length > 0 && (
          <p className="text-xs text-muted-foreground mt-0.5">{inc.entityNames.join(', ')}</p>
        )}
        <p className="text-xs text-muted-foreground mt-0.5">Opened {relTime(inc.createdAt)}</p>
      </div>
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

type Tab = 'feed' | 'accounts' | 'system';

export default function AdminOverviewPage() {
  const router                = useRouter();
  const { isSuperAdmin, isLoaded } = useRole();
  const { getToken }          = useAuth();

  const [data, setData]       = useState<ActivityOverview | null>(null);
  const [health, setHealth]   = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [healthLoading, setHealthLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [lastFetch, setLast]  = useState<Date | null>(null);
  const [tab, setTab]         = useState<Tab>('system');
  const [search, setSearch]   = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    if (isLoaded && !isSuperAdmin) router.replace('/home');
  }, [isLoaded, isSuperAdmin, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const [overview, sys] = await Promise.all([
        getActivityOverview(token ?? undefined),
        getSystemHealth(token ?? undefined),
      ]);
      setData(overview);
      setHealth(sys);
      setLast(new Date());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
      setHealthLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (isLoaded && isSuperAdmin) load();
  }, [isLoaded, isSuperAdmin, load]);

  if (!isLoaded || !isSuperAdmin) return null;

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
    <PageShell maxWidth="7xl">
      <PageHeader
        title="Platform Overview"
        badge={<EngineHexagon size={22} className="text-primary shrink-0" />}
        subtitle={lastFetch ? `Last updated ${lastFetch.toLocaleTimeString()}` : 'Global activity across all customer accounts'}
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
          {([
            ['system',   'System Health'],
            ['feed',     'Activity Feed'],
            ['accounts', 'Accounts'],
          ] as [Tab, string][]).map(([t, label]) => (
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
              {label}
              {t === 'system' && (health?.incidents?.length ?? 0) > 0 && (
                <span className="ml-1.5 bg-red-500 text-white text-[10px] rounded-full px-1.5">{health!.incidents.length}</span>
              )}
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
                <th className="text-left px-4 py-2.5 af-subhead">Account</th>
                <th className="text-left px-4 py-2.5 af-subhead">Type</th>
                <th className="text-left px-4 py-2.5 af-subhead">Topic</th>
                <th className="text-left px-4 py-2.5 af-subhead">Status</th>
                <th className="text-right px-4 py-2.5 af-subhead">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredFeed.map((item) => (
                <tr
                  key={item.id}
                  className="hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => router.push(`/operator?customerId=${item.customerId}`)}
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
                <th className="text-left px-4 py-2.5 af-subhead">Account</th>
                <th className="text-left px-4 py-2.5 af-subhead">Plan</th>
                <th className="text-right px-4 py-2.5 af-subhead">Total</th>
                <th className="text-right px-4 py-2.5 af-subhead">7d</th>
                <th className="text-right px-4 py-2.5 af-subhead">Published</th>
                <th className="text-right px-4 py-2.5 af-subhead">Running</th>
                <th className="text-right px-4 py-2.5 af-subhead">Failed</th>
                <th className="text-right px-4 py-2.5 af-subhead">Last login</th>
                <th className="text-right px-4 py-2.5 af-subhead">Last job</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredAccounts.map((acc) => {
                const name = [acc.firstName, acc.lastName].filter(Boolean).join(' ');
                return (
                  <tr
                    key={acc.customerId}
                    className="hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => router.push(`/operator?customerId=${acc.customerId}`)}
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
                    <td className="px-4 py-3 text-right text-xs tabular-nums">
                      <span className={acc.lastSignInAt ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                        {relTime(acc.lastSignInAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums">
                      {relTime(acc.lastJobAt)}
                    </td>
                  </tr>
                );
              })}
              {filteredAccounts.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No accounts match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── System Health tab ── */}
      {tab === 'system' && (
        <div className="space-y-6">

          {/* Open incidents */}
          <section className="space-y-2">
            <h2 className="af-h3">
              New Relic Incidents
              {' '}
              <span className="font-normal af-label">
                {healthLoading ? '(loading…)' : health?.incidents?.length === 0 ? '— all clear' : `— ${health?.incidents?.length} open`}
              </span>
            </h2>
            {(health?.incidents ?? []).length === 0 && !healthLoading && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30 px-4 py-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                <span className="text-sm text-emerald-700 dark:text-emerald-300">No open incidents — all clear</span>
              </div>
            )}
            {(health?.incidents ?? []).map((inc) => (
              <IncidentCard key={inc.issueId} inc={inc} />
            ))}
          </section>

          {/* Render services */}
          <section className="space-y-2">
            <h2 className="af-h3">Render Services</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(health?.renderServices ?? RENDER_SERVICES_PLACEHOLDER).map((svc) => (
                <ServiceCard key={svc.id} svc={svc as RenderService} />
              ))}
            </div>
          </section>

          {/* NR metrics */}
          <section className="space-y-2">
            <h2 className="af-h3">
              New Relic Metrics
              <span className="ml-1 font-normal af-caption">last 1 hour</span>
            </h2>
            {health?.nrMetrics && (() => {
              const m = health.nrMetrics;
              const apps = Array.from(new Set([
                ...Object.keys(m.errorRate   ?? {}),
                ...Object.keys(m.throughput  ?? {}),
              ])).filter(Boolean);
              return (
                <div className="space-y-4">
                  {apps.map((app) => (
                    <div key={app} className="rounded-lg border border-border p-4 space-y-3">
                      <p className="text-sm font-medium">{app}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        <MetricBox
                          label="Error rate"
                          value={(m.errorRate?.[app]) != null ? `${m.errorRate[app]!.toFixed(2)}%` : null}
                          warn={((m.errorRate?.[app]) ?? 0) > 1}
                        />
                        <MetricBox
                          label="Throughput"
                          value={(m.throughput?.[app]) != null ? `${m.throughput[app]!.toFixed(1)} rpm` : null}
                        />
                        <MetricBox
                          label="Avg latency"
                          value={(m.latencyMs?.[app]) != null ? `${Math.round(m.latencyMs[app]!)} ms` : null}
                          warn={((m.latencyMs?.[app]) ?? 0) > 2000}
                        />
                        <MetricBox
                          label="Apdex"
                          value={(m.apdex?.[app]) != null ? m.apdex[app]!.toFixed(2) : null}
                          warn={((m.apdex?.[app]) ?? 1) < 0.7}
                        />
                        <MetricBox
                          label="Errors (24h)"
                          value={(m.errors24h?.[app]) ?? 0}
                          warn={((m.errors24h?.[app]) ?? 0) > 0}
                        />
                      </div>
                    </div>
                  ))}
                  {apps.length === 0 && !healthLoading && (
                    <p className="text-sm text-muted-foreground">No APM data yet — agents may still be warming up.</p>
                  )}
                </div>
              );
            })()}
          </section>

          {health?.generatedAt && (
            <p className="text-xs text-muted-foreground">
              Snapshot generated at {new Date(health.generatedAt).toLocaleTimeString()} — click Refresh for latest data.
            </p>
          )}
        </div>
      )}

      <p className="af-caption">
        Click any row to view that account in the operator view. &nbsp;·&nbsp;
        Showing most recent 50 jobs in the activity feed.
      </p>
    </PageShell>
  );
}

const RENDER_SERVICES_PLACEHOLDER = [
  { id: 'srv-d7nsd77avr4c73frifcg', name: 'auraflux-api',    type: 'web',  suspended: null, url: null, deploy: null, previousDeploy: null },
  { id: 'srv-d7pnalhj2pic73btevl0', name: 'auraflux-app',    type: 'web',  suspended: null, url: null, deploy: null, previousDeploy: null },
  { id: 'crn-d7plhl0js32c73dviho0', name: 'auraflux-backup', type: 'cron', suspended: 'suspended', url: null, deploy: null, previousDeploy: null },
];
