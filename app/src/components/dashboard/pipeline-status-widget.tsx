'use client';
/**
 * PipelineStatusWidget — live active jobs count for the dashboard home (CPD-105).
 * Polls /jobs every 10s while the page is open.
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { listJobs, type Job } from '@/lib/api';

export function PipelineStatusWidget() {
  const { getToken } = useAuth();
  const [jobs, setJobs]       = useState<Job[]>([]);
  const [loaded, setLoaded]   = useState(false);

  const fetchJobs = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await listJobs(token ?? undefined);
      setJobs(res.jobs ?? []);
    } catch {
      // non-fatal — widget degrades gracefully
    } finally {
      setLoaded(true);
    }
  }, [getToken]);

  useEffect(() => {
    fetchJobs();
    const timer = setInterval(fetchJobs, 10_000);
    return () => clearInterval(timer);
  }, [fetchJobs]);

  const active  = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const held    = jobs.filter((j) => j.status === 'held');
  const failed  = jobs.filter((j) => j.status === 'failed');

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Loading pipeline…</p>;
  }

  if (active.length === 0 && held.length === 0 && failed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No active jobs.{' '}
        <Link href="/dashboard/jobs/new" className="text-foreground underline underline-offset-2">
          Start one
        </Link>.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {active.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span className="text-sm font-medium">{active.length}</span>
            <span className="text-sm text-muted-foreground">active</span>
          </div>
        )}
        {held.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
            <span className="text-sm font-medium">{held.length}</span>
            <span className="text-sm text-muted-foreground">held</span>
          </div>
        )}
        {failed.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-destructive" />
            <span className="text-sm font-medium">{failed.length}</span>
            <span className="text-sm text-muted-foreground">failed</span>
          </div>
        )}
      </div>

      {/* Most recent active job */}
      {active[0] && (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-mono text-muted-foreground truncate">{active[0].jobId}</span>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="text-[10px] capitalize px-1.5">{active[0].status}</Badge>
            <Link
              href={`/dashboard/jobs/${active[0].jobId}`}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-xs h-6 px-2')}
            >
              View
            </Link>
          </div>
        </div>
      )}

      <Link
        href="/dashboard/jobs"
        className="text-xs text-muted-foreground underline underline-offset-2"
      >
        View all jobs →
      </Link>
    </div>
  );
}
