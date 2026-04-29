'use client';
/**
 * /dashboard/operator — Operator dashboard (CPD-23)
 *
 * Full portal detail view for all clients' jobs.
 * Accessible only to users with role = operator | admin.
 */

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { JobCard } from '@/components/jobs/job-card';
import { listAllJobs, type Job } from '@/lib/api';
import { useRole } from '@/hooks/use-role';

export default function OperatorPage() {
  const router  = useRouter();
  const { role, isOperator, isLoaded } = useRole();
  const { getToken } = useAuth();

  const [jobs, setJobs]       = useState<Job[]>([]);
  const [isPending, start]    = useTransition();
  const [error, setError]     = useState<string | null>(null);
  const [lastFetch, setLast]  = useState<Date | null>(null);
  const [filter, setFilter]   = useState<Job['status'] | 'all'>('all');

  // Redirect non-operators back to dashboard
  useEffect(() => {
    if (isLoaded && !isOperator) router.replace('/dashboard');
  }, [isLoaded, isOperator, router]);

  async function fetchJobs() {
    start(async () => {
      try {
        const token = await getToken();
        const res = await listAllJobs(token ?? undefined);
        setJobs(res.jobs ?? []);
        setLast(new Date());
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load jobs');
      }
    });
  }

  useEffect(() => {
    if (isLoaded && isOperator) fetchJobs();
  }, [isLoaded, isOperator]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isLoaded) return null;
  if (!isOperator) return null;

  const STATUSES: Array<Job['status'] | 'all'> = ['all', 'running', 'held', 'failed', 'complete'];
  const filtered = filter === 'all' ? jobs : jobs.filter((j) => j.status === filter);

  // Aggregate metrics
  const metrics = {
    total:    jobs.length,
    running:  jobs.filter((j) => j.status === 'running').length,
    failed:   jobs.filter((j) => j.status === 'failed').length,
    held:     jobs.filter((j) => j.status === 'held').length,
    complete: jobs.filter((j) => j.status === 'complete').length,
  };

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Operator</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Role: <span className="font-medium">{role}</span>
            {lastFetch && ` · Updated ${lastFetch.toLocaleTimeString()}`}
          </p>
        </div>
        <button
          onClick={fetchJobs}
          disabled={isPending}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), isPending && 'opacity-50')}
        >
          {isPending ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {(Object.entries(metrics) as [string, number][]).map(([key, val]) => (
          <Card key={key} className="text-center py-2">
            <CardContent className="p-0">
              <p className="text-2xl font-semibold">{val}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{key}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Separator />

      {/* Filter tabs */}
      <div className="flex gap-1">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={cn(
              'px-2.5 py-1 text-xs rounded border transition-colors capitalize',
              filter === s
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {s}
            {s !== 'all' && (
              <span className="ml-1 opacity-60">
                {jobs.filter((j) => j.status === s).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      {/* Job grid — detailed mode shows full portal breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((job) => (
          <JobCard key={job.jobId} job={job} detailed />
        ))}
        {filtered.length === 0 && !isPending && (
          <p className="col-span-full text-sm text-muted-foreground text-center py-8">
            No jobs match the current filter.
          </p>
        )}
      </div>
    </div>
  );
}
