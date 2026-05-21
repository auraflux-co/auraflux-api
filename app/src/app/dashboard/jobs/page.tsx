'use client';
/**
 * /dashboard/jobs — Jobs hub (CPD-112)
 *
 * Quick-stat cards linking to Active and History sub-pages.
 * Fetches job list on mount to compute counts.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { listJobs, type Job } from '@/lib/api';
import { useGuide } from '@/contexts/guide-context';
import { usePlan } from '@/contexts/plan-context';
import { useRouter } from 'next/navigation';

const ACTIVE_STATUSES  = new Set(['queued', 'running', 'held', 'failed']);
const SCHEDULED_STATUSES = new Set(['queued_scheduled']);
const COMPLETE_STATUSES = new Set(['complete', 'published']);

interface StatCardProps {
  href:    string;
  label:   string;
  count:   number | null;
  sub?:    string;
  accent?: boolean;
}

function StatCard({ href, label, count, sub, accent }: StatCardProps) {
  return (
    <Link href={href} className="group block">
      <Card className={cn('transition-colors group-hover:border-primary/50', accent && count && count > 0 ? 'border-yellow-500/50' : '')}>
        <CardContent className="pt-5 pb-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
          <p className="text-3xl font-bold mt-1 tabular-nums">
            {count === null ? '—' : count}
          </p>
          {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
        </CardContent>
      </Card>
    </Link>
  );
}

export default function JobsHubPage() {
  const { getToken, isLoaded } = useAuth();
  const router                 = useRouter();
  const { openWithContext }    = useGuide();
  const { planTier }           = usePlan();
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
      } catch (e: unknown) {
        setError("Couldn't load your jobs. Refresh to try again.");
      }
    }
    load();
  }, [getToken, isLoaded]);

  const active   = jobs?.filter((j) => ACTIVE_STATUSES.has(j.status)) ?? [];
  const held     = jobs?.filter((j) => j.status === 'held' || j.status === 'failed') ?? [];
  const complete = jobs?.filter((j) => COMPLETE_STATUSES.has(j.status)) ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">My Jobs</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Create, monitor, and review your production jobs</p>
        </div>
        {isOperate ? (
          <Link href="/dashboard/settings/api-keys" className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}>
            API Keys
          </Link>
        ) : (
          <Link href="/dashboard/jobs/new" className={cn(buttonVariants({ size: 'sm' }))}>
            + New job
          </Link>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          href="/dashboard/jobs/active"
          label="Active"
          count={jobs === null ? null : active.length}
          sub="queued + running"
        />
        <StatCard
          href="/dashboard/jobs/active"
          label="Needs attention"
          count={jobs === null ? null : held.length}
          sub="held or failed"
          accent
        />
        <StatCard
          href="/dashboard/jobs/history"
          label="Completed"
          count={jobs === null ? null : complete.length}
          sub="all time"
        />
      </div>

      {/* Operate plan: API-first banner */}
      {isOperate && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-950/20 p-5 space-y-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0">
              <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Submit jobs via API</p>
              <p className="text-xs text-gray-400 mt-1">
                Your Operate plan is API-first. Use <code className="text-indigo-400">POST https://api.auraflux.co/v1/jobs</code> to submit jobs
                programmatically. This page shows real-time status of everything running.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href="/dashboard/settings/api-keys" className={cn(buttonVariants({ size: 'sm' }))}>
              Get API key
            </Link>
            <a
              href="https://robertsworkspace-18914505.atlassian.net/wiki/spaces/CP/pages/8192001"
              target="_blank" rel="noopener noreferrer"
              className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}
            >
              API docs →
            </a>
          </div>
        </div>
      )}

      {/* AuraFlux Guide CTA — Guided + Managed only (Operate users use the API) */}
      {!isOperate && <div className="rounded-lg border border-primary/25 bg-primary/5 p-4 flex items-start gap-4">
        <div className="mt-0.5 shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
            <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Not sure what to select?</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Get guided help through format, source, features, and publishing — so your job is configured correctly before it starts production.
          </p>
        </div>
        <button
          onClick={() => {
            openWithContext('Ready to help you configure your next job. Tell me what type of content you produce and I\'ll walk you through the best setup.');
            router.push('/dashboard/jobs/new');
          }}
          className={cn(buttonVariants({ size: 'sm' }), 'shrink-0')}
        >
          Get guided help
        </button>
      </div>}

      {/* Quick links */}
      <div>
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          <Link href="/dashboard/jobs/new"     className={cn(buttonVariants({ size: 'sm' }))}>New job</Link>
          <Link href="/dashboard/jobs/active"  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>View active</Link>
          <Link href="/dashboard/jobs/history" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>View history</Link>
        </div>
      </div>

      {/* Empty state */}
      {jobs !== null && jobs.length === 0 && (
        <div className="text-center py-16 border border-dashed rounded-lg">
          <p className="text-sm text-muted-foreground">No jobs yet — create your first one.</p>
          <Link href="/dashboard/jobs/new" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}>
            Create job
          </Link>
        </div>
      )}

      {/* Status legend */}
      {jobs !== null && jobs.length > 0 && (
        <div className="flex flex-wrap gap-4 text-[10px] text-muted-foreground">
          {[
            { s: 'running', label: 'Running',  color: 'bg-blue-500' },
            { s: 'queued',  label: 'Queued',   color: 'bg-muted/40' },
            { s: 'held',    label: 'Held',     color: 'bg-yellow-500' },
            { s: 'failed',  label: 'Failed',   color: 'bg-destructive' },
            { s: 'complete',label: 'Complete', color: 'bg-green-500' },
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
    </div>
  );
}
