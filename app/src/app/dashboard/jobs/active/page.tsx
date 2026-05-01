'use client';
/**
 * /dashboard/jobs/active — In-flight jobs (CPD-112)
 *
 * Shows jobs with status: queued | running | held | failed.
 * Auto-refreshes every 15 seconds. Operators see inline actions.
 */

import { useEffect, useState, useTransition, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { buttonVariants, Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { listJobs, operatorJobAction, type Job, type OperatorAction } from '@/lib/api';
import { useRole } from '@/hooks/use-role';

const ACTIVE_STATUSES = new Set(['queued', 'running', 'held', 'failed']);
const POLL_MS = 15_000;

function statusColor(s: string) {
  if (s === 'running') return 'bg-blue-500 animate-pulse';
  if (s === 'queued')  return 'bg-muted/60';
  if (s === 'held')    return 'bg-yellow-500';
  if (s === 'failed')  return 'bg-destructive';
  return 'bg-muted/30';
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'failed' ? 'destructive' :
    status === 'held'   ? 'secondary'   :
    'outline';
  return (
    <Badge variant={variant} className="capitalize text-[10px]">
      <span className={cn('w-1.5 h-1.5 rounded-full mr-1.5 inline-block', statusColor(status))} />
      {status}
    </Badge>
  );
}

function elapsed(createdAt: string) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const m  = Math.floor(ms / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export default function ActiveJobsPage() {
  const { getToken }    = useAuth();
  const { isOperator }  = useRole();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError]       = useState<string | null>(null);
  const [lastPoll, setLastPoll] = useState<Date | null>(null);
  const [isPending, start]      = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchJobs = useCallback(() => {
    start(async () => {
      try {
        const token = await getToken();
        const res = await listJobs(token ?? undefined);
        setJobs((res.jobs ?? []).filter((j) => ACTIVE_STATUSES.has(j.status)));
        setLastPoll(new Date());
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load jobs');
      }
    });
  }, [getToken]);

  useEffect(() => {
    fetchJobs();
    const id = setInterval(fetchJobs, POLL_MS);
    return () => clearInterval(id);
  }, [fetchJobs]);

  async function handleAction(jobId: string, action: OperatorAction) {
    setActionError(null);
    try {
      const token = await getToken();
      await operatorJobAction(jobId, action, token ?? undefined);
      fetchJobs();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : `Failed to ${action} job`);
    }
  }

  const heldOrFailed = jobs.filter((j) => j.status === 'held' || j.status === 'failed');
  const inProgress   = jobs.filter((j) => j.status === 'queued' || j.status === 'running');

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Active jobs</h1>
          {lastPoll && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Auto-refreshes every 15s · last at {lastPoll.toLocaleTimeString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchJobs}
            disabled={isPending}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), isPending && 'opacity-50')}
          >
            {isPending ? 'Refreshing…' : 'Refresh'}
          </button>
          <Link href="/dashboard/jobs/new" className={cn(buttonVariants({ size: 'sm' }))}>
            + New job
          </Link>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}
      {actionError && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{actionError}</p>
      )}

      {/* Needs attention */}
      {heldOrFailed.length > 0 && (
        <section>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Needs attention ({heldOrFailed.length})
          </h2>
          <div className="space-y-2">
            {heldOrFailed.map((job) => (
              <JobRow key={job.jobId} job={job} isOperator={isOperator} onAction={handleAction} />
            ))}
          </div>
        </section>
      )}

      {/* In progress */}
      {inProgress.length > 0 && (
        <section>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            In progress ({inProgress.length})
          </h2>
          <div className="space-y-2">
            {inProgress.map((job) => (
              <JobRow key={job.jobId} job={job} isOperator={isOperator} onAction={handleAction} />
            ))}
          </div>
        </section>
      )}

      {/* Empty */}
      {!isPending && jobs.length === 0 && !error && (
        <div className="text-center py-16 border border-dashed rounded-lg">
          <p className="text-sm text-muted-foreground">No active jobs right now.</p>
          <Link href="/dashboard/jobs/new" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}>
            Create a job
          </Link>
        </div>
      )}
    </div>
  );
}

function JobRow({
  job,
  isOperator,
  onAction,
}: {
  job: Job;
  isOperator: boolean;
  onAction: (jobId: string, action: OperatorAction) => void;
}) {
  const currentPortal = job.portalReports?.find((p) => p.status === 'running' || p.status === 'hold' || p.status === 'failed');
  const portalLabel = currentPortal
    ? currentPortal.portal.replace('portal', 'P').replace('b', 'b')
    : null;

  return (
    <Card>
      <CardContent className="py-3 px-4">
        <div className="flex items-start gap-3">
          {/* Portal strip */}
          <div className="flex gap-0.5 mt-1 shrink-0">
            {(job.portalReports ?? []).map((p) => (
              <span
                key={p.portal}
                title={p.portal}
                className={cn('w-1.5 h-5 rounded-sm', statusColor(p.status))}
              />
            ))}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/dashboard/jobs/${job.jobId}`}
                className="text-sm font-medium hover:underline truncate max-w-[180px]"
              >
                {job.jobId.slice(0, 8)}…
              </Link>
              <StatusBadge status={job.status} />
              {portalLabel && (
                <span className="text-[10px] text-muted-foreground">@ {portalLabel}</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {job.contentType || 'unknown'} · {job.platforms.join(', ') || 'no platform'} · {elapsed(job.createdAt)}
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Link
              href={`/dashboard/jobs/${job.jobId}`}
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-xs h-7 px-2')}
            >
              Details →
            </Link>
            {isOperator && (job.status === 'held' || job.status === 'failed') && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 px-2"
                  onClick={() => onAction(job.jobId, 'retry')}
                >
                  Retry
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 px-2"
                  onClick={() => onAction(job.jobId, 'advance')}
                >
                  Advance
                </Button>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
