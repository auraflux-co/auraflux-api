'use client';
/**
 * RecentJobsList — shows the last 3 completed, published, staged, or failed
 * jobs on the dashboard home so users have instant visibility into what was
 * recently produced without navigating to /dashboard/jobs.
 *
 * Fetches once on mount. No polling needed — users who want live updates
 * can navigate to /dashboard/jobs.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { listJobs, type Job } from '@/lib/api';

const RECENT_STATUSES = new Set(['complete', 'published', 'staged', 'failed']);
const LIMIT = 3;

const STATUS_STYLE: Record<string, { label: string; classes: string }> = {
  complete:  { label: 'Complete',  classes: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  published: { label: 'Published', classes: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300' },
  staged:    { label: 'In review', classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  failed:    { label: 'Failed',    classes: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
};

function fmtDate(s: string) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000)   return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtContentType(ct: string) {
  if (!ct) return '—';
  return ct.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function RecentJobsList() {
  const { getToken }         = useAuth();
  const [jobs, setJobs]      = useState<Job[]>([]);
  const [loaded, setLoaded]  = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const res   = await listJobs(token ?? undefined);
        if (!cancelled) {
          const recent = (res.jobs ?? [])
            .filter((j) => RECENT_STATUSES.has(j.status))
            .slice(0, LIMIT);
          setJobs(recent);
        }
      } catch {
        // non-fatal
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [getToken]);

  if (!loaded) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-5 w-16 rounded-full bg-muted ml-auto" />
          </div>
        ))}
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No completed jobs yet —{' '}
        <Link href="/dashboard/jobs/new" className="text-primary hover:underline">
          start one now →
        </Link>
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {jobs.map((job) => {
        const s = STATUS_STYLE[job.status] ?? { label: job.status, classes: 'bg-muted text-muted-foreground' };
        const label = (job as Job & { topic?: string }).topic
          || fmtContentType(job.contentType)
          || job.jobId;

        return (
          <Link
            key={job.jobId}
            href={`/dashboard/jobs/${job.jobId}`}
            className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50"
          >
            <p className="flex-1 text-sm text-foreground truncate min-w-0">{label}</p>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-muted-foreground">{fmtDate(job.updatedAt)}</span>
              <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium', s.classes)}>
                {s.label}
              </span>
            </div>
          </Link>
        );
      })}

      <div className="flex justify-end pt-1 px-3">
        <Link href="/dashboard/jobs" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
          View all jobs →
        </Link>
      </div>
    </div>
  );
}
