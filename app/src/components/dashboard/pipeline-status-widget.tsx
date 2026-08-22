'use client';
/**
 * PipelineStatusWidget — live active jobs for the dashboard home (CPD-105, CPD-204).
 * Polls /jobs every 10s. Skeleton loading, rich empty state, topic display.
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/clerk-compat';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { listJobs, type Job } from '@/lib/api';
import { jobDisplayTitle } from '@/lib/job-labels';

const STATUS_CONFIG: Record<string, { color: string; label: string; pulse?: boolean }> = {
  running: { color: 'bg-blue-500',     label: 'Running',   pulse: true  },
  queued:  { color: 'bg-amber-400',    label: 'Queued'                   },
  held:    { color: 'bg-yellow-500',   label: 'Held'                     },
  failed:  { color: 'bg-destructive',  label: 'Failed'                   },
};

function FilmIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
      <rect width="20" height="20" x="2" y="2" rx="2.18" ry="2.18" />
      <line x1="7"  x2="7"  y1="2"  y2="22" />
      <line x1="17" x2="17" y1="2"  y2="22" />
      <line x1="2"  x2="22" y1="12" y2="12" />
      <line x1="2"  x2="7"  y1="7"  y2="7"  />
      <line x1="2"  x2="7"  y1="17" y2="17" />
      <line x1="17" x2="22" y1="7"  y2="7"  />
      <line x1="17" x2="22" y1="17" y2="17" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

export function PipelineStatusWidget() {
  const { getToken }           = useAuth();
  const [jobs, setJobs]        = useState<Job[]>([]);
  const [loaded, setLoaded]    = useState(false);
  const [spinning, setSpinning] = useState(false);

  const fetchJobs = useCallback(async () => {
    setSpinning(true);
    try {
      const token = await getToken();
      const res   = await listJobs(token ?? undefined);
      setJobs(res.jobs ?? []);
    } catch {
      // non-fatal — widget degrades gracefully
    } finally {
      setLoaded(true);
      setTimeout(() => setSpinning(false), 600);
    }
  }, [getToken]);

  useEffect(() => {
    fetchJobs();
    const timer = setInterval(fetchJobs, 10_000);
    return () => clearInterval(timer);
  }, [fetchJobs]);

  // Skeleton loading state
  if (!loaded) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 animate-pulse">
            <span className="h-2.5 w-2.5 rounded-full bg-muted shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-4 w-3/4 rounded bg-muted" />
              <div className="h-3 w-1/3 rounded bg-muted" />
            </div>
            <div className="h-5 w-16 rounded-full bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const held   = jobs.filter((j) => j.status === 'held');
  const failed = jobs.filter((j) => j.status === 'failed');

  // Rich empty state
  if (active.length === 0 && held.length === 0 && failed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="rounded-xl bg-muted/60 p-4 mb-4">
          <FilmIcon />
        </div>
        <h3 className="text-sm font-semibold text-foreground mb-1">No jobs running</h3>
        <p className="text-xs text-muted-foreground mb-4">Ready when you are</p>
        <Link href="/myjobs/new" className={cn(buttonVariants({ size: 'sm' }))}>
          Create your first job
        </Link>
      </div>
    );
  }

  const visibleJobs = [...active, ...held, ...failed].slice(0, 5);

  const statusCounts = visibleJobs.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="space-y-1">
      {visibleJobs.map((job) => {
        const cfg  = STATUS_CONFIG[job.status] ?? { color: 'bg-muted', label: job.status };
        const name = jobDisplayTitle(job);

        return (
          <Link
            key={job.jobId}
            href={`/myjobs/${job.jobId}`}
            className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50"
          >
            <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', cfg.color, cfg.pulse && 'animate-pulse')} />
            <p className="flex-1 text-sm font-medium text-foreground truncate min-w-0">{name}</p>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground shrink-0">
              {cfg.label}
              {(statusCounts[job.status] ?? 0) > 1 && (
                <span className="text-[10px] opacity-70">({statusCounts[job.status]})</span>
              )}
            </span>
          </Link>
        );
      })}

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 px-3">
        <div className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', !spinning && 'opacity-0')}>
          <RefreshIcon />
          <span>Refreshing</span>
        </div>
        <Link href="/myjobs" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-xs h-7 gap-1 text-muted-foreground hover:text-foreground')}>
          View all jobs
          <span className="transition-transform group-hover:translate-x-0.5">→</span>
        </Link>
      </div>
    </div>
  );
}
