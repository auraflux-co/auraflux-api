'use client';
/**
 * ReviewQueueWidget — shows a count of jobs waiting for user review (status:
 * complete, staged, or operator_review (CPD-431 grade-99 hold)). Appears on the dashboard home alongside the pipeline
 * status so users immediately see when output is ready to approve and publish.
 *
 * Polls every 15s (less aggressive than the pipeline widget — review state
 * changes less frequently than running state).
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/clerk-compat';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { listJobs, type Job } from '@/lib/api';
import { isReviewQueueJob } from '@/lib/job-labels';

export function ReviewQueueWidget() {
  const { getToken }           = useAuth();
  const [count, setCount]      = useState<number | null>(null);
  const [failed, setFailed]    = useState(0);
  const [loaded, setLoaded]    = useState(false);

  const fetchJobs = useCallback(async () => {
    try {
      const token = await getToken();
      const res   = await listJobs(token ?? undefined);
      const jobs  = res.jobs ?? [] as Job[];
      setCount(jobs.filter(isReviewQueueJob).length);
      setFailed(jobs.filter((j) => j.status === 'failed').length);
    } catch {
      // non-fatal
    } finally {
      setLoaded(true);
    }
  }, [getToken]);

  useEffect(() => {
    fetchJobs();
    const t = setInterval(fetchJobs, 15_000);
    return () => clearInterval(t);
  }, [fetchJobs]);

  if (!loaded) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-8 w-12 rounded bg-muted" />
        <div className="h-4 w-28 rounded bg-muted" />
      </div>
    );
  }

  const hasReady = (count ?? 0) > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Count */}
      <div className="flex-1 flex flex-col justify-center gap-1">
        <p className={cn(
          'text-4xl font-bold tabular-nums leading-none',
          hasReady ? 'text-foreground' : 'text-muted-foreground/40',
        )}>
          {count ?? 0}
        </p>
        <p className="text-sm text-muted-foreground">
          {count === 1 ? 'job ready to review' : 'jobs ready to review'}
        </p>

        {failed > 0 && (
          <p className="text-xs text-destructive mt-1">
            {failed} failed — needs attention
          </p>
        )}
      </div>

      {/* CTA */}
      <div className="mt-4">
        {hasReady ? (
          <Link
            href="/review"
            className={cn(buttonVariants({ size: 'sm' }), 'w-full sm:w-auto')}
          >
            Go to review queue →
          </Link>
        ) : (
          <Link
            href="/review"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-muted-foreground text-xs px-0')}
          >
            View review queue →
          </Link>
        )}
      </div>
    </div>
  );
}
