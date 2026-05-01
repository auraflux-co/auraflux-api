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

const ACTIVE_STATUSES  = new Set(['queued', 'running', 'held', 'failed']);
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
  const { getToken } = useAuth();
  const [jobs, setJobs]   = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const res = await listJobs(token ?? undefined);
        setJobs(res.jobs ?? []);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load jobs');
      }
    }
    load();
  }, [getToken]);

  const active   = jobs?.filter((j) => ACTIVE_STATUSES.has(j.status)) ?? [];
  const held     = jobs?.filter((j) => j.status === 'held' || j.status === 'failed') ?? [];
  const complete = jobs?.filter((j) => COMPLETE_STATUSES.has(j.status)) ?? [];

  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Create, monitor, and review your production jobs</p>
        </div>
        <Link href="/dashboard/jobs/new" className={cn(buttonVariants({ size: 'sm' }))}>
          + New job
        </Link>
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
