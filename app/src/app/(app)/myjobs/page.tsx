'use client';
/**
 * /myjobs — Jobs hub (CPD-112)
 *
 * Quick-stat cards linking to Active and History sub-pages.
 * Fetches job list on mount to compute counts.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { listJobs, type Job } from '@/lib/api';
import { useGuide } from '@/contexts/guide-context';
import { usePlan } from '@/contexts/plan-context';
import { useBrand } from '@/contexts/brand-context';
import { useRole } from '@/hooks/use-role';
import { useRouter } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { EmptyState } from '@/components/ui/empty-state';

const ACTIVE_STATUSES    = new Set(['queued', 'running', 'held', 'failed']);
const SCHEDULED_STATUSES = new Set(['queued_scheduled']);
const STAGED_STATUSES    = new Set(['staged']);
const COMPLETE_STATUSES  = new Set(['complete', 'published']);

interface StatCardProps {
  href:    string;
  label:   string;
  count:   number | null;
  sub?:    string;
  variant?: 'default' | 'warn' | 'success' | 'active';
}

function StatCard({ href, label, count, sub, variant = 'default' }: StatCardProps) {
  const borderCls =
    variant === 'warn'    ? 'border-yellow-700/50 bg-yellow-950/10' :
    variant === 'success' ? 'border-emerald-700/50 bg-emerald-950/10' :
    variant === 'active'  ? 'border-blue-700/50 bg-blue-950/10' :
    '';
  const numCls =
    variant === 'warn'    ? 'text-yellow-400' :
    variant === 'success' ? 'text-emerald-400' :
    variant === 'active'  ? 'text-blue-400' :
    'text-foreground';
  const hasCount = count !== null && count > 0;

  return (
    <Link href={href} className="group block">
      <div className={cn(
        'af-surface px-5 py-4 transition-all rounded-xl',
        'group-hover:border-primary/30 group-hover:shadow-sm',
        hasCount && variant !== 'default' ? borderCls : '',
      )}>
        <p className="af-subhead text-muted-foreground">{label}</p>
        <p className={cn('af-metric mt-1.5', count === null ? 'text-foreground/30' : numCls)}>
          {count === null ? '—' : count}
        </p>
        {sub && <p className="af-caption mt-1 text-muted-foreground/70">{sub}</p>}
      </div>
    </Link>
  );
}

export default function JobsHubPage() {
  const { getToken, isLoaded } = useAuth();
  const router                 = useRouter();
  const { openWithContext }    = useGuide();
  const { planTier }           = usePlan();
  const { activeBrand }        = useBrand();
  const { isSuperAdmin }       = useRole();
  const activeBrandId          = activeBrand?.id;
  const isOperate              = planTier === 'operate' || planTier === null;
  const [jobs, setJobs]        = useState<Job[] | null>(null);
  const [error, setError]      = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    async function load() {
      try {
        const token = await getToken();
        const res = await listJobs(token ?? undefined);
        setJobs(res.jobs ?? []);
      } catch {
        setError("Couldn't load your jobs. Refresh to try again.");
      }
    }
    load();
  }, [getToken, isLoaded, activeBrandId]);

  const active    = jobs?.filter((j) => ACTIVE_STATUSES.has(j.status)) ?? [];
  // CPD-588: failed = system error, not customer-actionable — only count for superadmin
  const held      = jobs?.filter((j) => j.status === 'held' || (isSuperAdmin && j.status === 'failed')) ?? [];
  const staged    = jobs?.filter((j) => STAGED_STATUSES.has(j.status)) ?? [];
  const complete  = jobs?.filter((j) => COMPLETE_STATUSES.has(j.status)) ?? [];

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="My Jobs"
        subtitle="Create, monitor, and review your production jobs"
      >
        <div className="flex items-center gap-2">
          {isOperate && (
            <Link href="/settings/api-keys" className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}>
              API Keys
            </Link>
          )}
          <Link href="/myjobs/new" className={cn(buttonVariants({ size: 'sm' }))}>
            + New job
          </Link>
        </div>
      </PageHeader>

      {error && (
        <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard href="/myjobs/active"  label="Active"           count={jobs === null ? null : active.length}   sub="queued + running" variant="active" />
        <StatCard href="/myjobs/active"  label="Needs attention"  count={jobs === null ? null : held.length}     sub="held or failed"   variant="warn" />
        <StatCard href="/review"         label="Ready to review"  count={jobs === null ? null : staged.length}   sub="awaiting approval" variant="success" />
        <StatCard href="/myjobs/history" label="Completed"        count={jobs === null ? null : complete.length} sub="all time" />
      </div>

      {/* Operate plan: API access info */}
      {isOperate && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-950/20 p-5 space-y-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0">
              <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            </div>
            <div>
              <p className="af-body font-semibold text-white">API access included</p>
              <p className="af-caption text-indigo-200/80 mt-1">
                Submit jobs via the dashboard wizard above or programmatically via{' '}
                <code className="text-indigo-300 bg-indigo-900/50 px-1 rounded">POST https://api.auraflux.co/v1/jobs</code>.
                {' '}All jobs appear here with real-time status regardless of how they were submitted.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href="/settings/api-keys" className={cn(buttonVariants({ size: 'sm' }))}>Get API key</Link>
            <a
              href="https://aurafluxco.atlassian.net/wiki/spaces/CP/pages/8192001"
              target="_blank" rel="noopener noreferrer"
              className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}
            >
              API docs →
            </a>
          </div>
        </div>
      )}

      {/* AuraFlux Guide CTA — Guided + Managed only */}
      {!isOperate && (
        <div className="rounded-lg border border-primary/25 bg-primary/5 p-4 flex items-start gap-4">
          <div className="mt-0.5 shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
              <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="af-body font-medium">Not sure what to select?</p>
            <p className="af-caption mt-0.5">
              Get guided help through format, source, features, and publishing — so your job is configured correctly before it starts production.
            </p>
          </div>
          <button
            onClick={() => {
              openWithContext('Ready to help you configure your next job. Tell me what type of content you produce and I\'ll walk you through the best setup.');
              router.push('/myjobs/new');
            }}
            className={cn(buttonVariants({ size: 'sm' }), 'shrink-0')}
          >
            Get guided help
          </button>
        </div>
      )}

      {/* Quick links */}
      <div className="flex flex-wrap gap-2">
        <Link href="/myjobs/new"     className={cn(buttonVariants({ size: 'sm' }))}>+ New job</Link>
        <Link href="/myjobs/active"  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>View active</Link>
        <Link href="/myjobs/history" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>View history</Link>
        <Link href="/review"         className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>Review queue</Link>
      </div>

      {/* Empty state */}
      {jobs !== null && jobs.length === 0 && (
        <EmptyState
          title="No jobs yet"
          description="Create your first production job to get started."
          action={{ label: 'Create job', href: '/myjobs/new' }}
        />
      )}

      {/* Status legend */}
      {jobs !== null && jobs.length > 0 && (
        <div className="flex flex-wrap gap-4 af-caption">
          {[
            { s: 'running',  label: 'Running',        color: 'bg-blue-500' },
            { s: 'queued',   label: 'Queued',         color: 'bg-muted/40' },
            { s: 'held',     label: 'Held',           color: 'bg-yellow-500' },
            { s: 'failed',   label: 'Failed',         color: 'bg-destructive' },
            { s: 'staged',   label: 'Ready to review', color: 'bg-green-500 animate-pulse' },
            { s: 'complete', label: 'Complete',       color: 'bg-green-500' },
            { s: 'published',label: 'Published',      color: 'bg-emerald-600' },
          ].map(({ s, label, color }) => (
            <span key={s} className="flex items-center gap-1">
              <span className={cn('w-2 h-2 rounded-full', color)} />
              {label}
              {jobs && (
                <Badge variant="outline" className="text-[9px] px-1 ml-0.5">
                  {jobs.filter((j) => j.status === s).length}
                </Badge>
              )}
            </span>
          ))}
        </div>
      )}
    </PageShell>
  );
}
