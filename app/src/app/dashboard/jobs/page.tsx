'use client';
/**
 * /dashboard/jobs — Customer jobs list (CPD-23)
 *
 * Shows the current user's jobs with portal status progress strip.
 * Fetches from GET /jobs using the Clerk session token.
 */

import { useEffect, useState, useTransition } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { JobCard } from '@/components/jobs/job-card';
import { listJobs, type Job } from '@/lib/api';

export default function JobsPage() {
  const { getToken } = useAuth();
  const [jobs, setJobs]       = useState<Job[]>([]);
  const [isPending, start]    = useTransition();
  const [error, setError]     = useState<string | null>(null);
  const [lastFetch, setLast]  = useState<Date | null>(null);

  async function fetchJobs() {
    start(async () => {
      try {
        const token = await getToken();
        const res = await listJobs(token ?? undefined);
        setJobs(res.jobs ?? []);
        setLast(new Date());
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load jobs');
      }
    });
  }

  useEffect(() => { fetchJobs(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Jobs</h1>
          {lastFetch && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Updated {lastFetch.toLocaleTimeString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchJobs}
            disabled={isPending}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), isPending && 'opacity-50')}
          >
            {isPending ? 'Loading…' : 'Refresh'}
          </button>
          <Link href="/dashboard/jobs/new" className={cn(buttonVariants({ size: 'sm' }))}>
            New job
          </Link>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      {!isPending && jobs.length === 0 && !error && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">No jobs yet.</p>
          <Link href="/dashboard/jobs/new" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}>
            Create your first job
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {jobs.map((job) => (
          <JobCard key={job.jobId} job={job} />
        ))}
      </div>

      {/* Portal legend */}
      {jobs.length > 0 && (
        <div className="flex gap-4 text-[10px] text-muted-foreground pt-2">
          {(['pass', 'running', 'hold', 'failed', 'pending'] as const).map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span className={cn('w-2 h-2 rounded-full',
                s === 'pass'    ? 'bg-green-500' :
                s === 'running' ? 'bg-blue-500' :
                s === 'hold'    ? 'bg-yellow-500' :
                s === 'failed'  ? 'bg-destructive' :
                'bg-muted/40'
              )} />
              {s}
            </span>
          ))}
          <Badge variant="outline" className="text-[10px] px-1.5 ml-auto">7 portals</Badge>
        </div>
      )}
    </div>
  );
}
