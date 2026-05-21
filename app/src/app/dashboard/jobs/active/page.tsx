'use client';
/**
 * /dashboard/jobs/active — In-flight jobs (CPD-112)
 *
 * Shows jobs with status: queued | running | held | failed.
 * Polls every 15s silently. Operators see inline actions.
 */

import { useEffect, useState, useTransition, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { buttonVariants, Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { listJobs, listTemplates, operatorJobAction, type Job, type JobTemplate, type OperatorAction } from '@/lib/api';
import { useRole } from '@/hooks/use-role';

const ACTIVE_STATUSES = new Set(['queued', 'running', 'held', 'failed']);
const SCHEDULED_JOB_STATUSES = new Set(['queued_scheduled']);
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

function fmtJobTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day:   'numeric',
    hour:  'numeric',
    minute: '2-digit',
  });
}

export default function ActiveJobsPage() {
  const { getToken, isLoaded } = useAuth();
  const { isOperator }         = useRole();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [scheduledJobs, setScheduledJobs] = useState<Job[]>([]);
  const [upcomingTemplates, setUpcomingTemplates] = useState<JobTemplate[]>([]);
  const [error, setError]       = useState<string | null>(null);

  const [isPending, start]      = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchJobs = useCallback(() => {
    start(async () => {
      try {
        const token = await getToken();
        const [{ jobs: all }, { templates }] = await Promise.all([
          listJobs(token ?? undefined),
          listTemplates(token ?? undefined),
        ]);
        const now = Date.now();
        setJobs((all ?? []).filter((j) => ACTIVE_STATUSES.has(j.status)));
        setScheduledJobs((all ?? []).filter((j) => SCHEDULED_JOB_STATUSES.has(j.status)));
        setUpcomingTemplates(
          (templates ?? []).filter(
            (t) => t.recurrenceActive && t.nextFireAt && new Date(t.nextFireAt).getTime() > now,
          ),
        );
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load jobs');
      }
    });
  }, [getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    fetchJobs();
    const id = setInterval(fetchJobs, POLL_MS);
    return () => clearInterval(id);
  }, [fetchJobs, isLoaded]);

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
          <h1 className="text-2xl font-semibold">My active jobs</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Scheduled, in progress, and jobs that need your attention
          </p>
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

      {(scheduledJobs.length > 0 || upcomingTemplates.length > 0) && (
        <section>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Scheduled ({scheduledJobs.length + upcomingTemplates.length})
          </h2>
          <div className="space-y-2">
            {scheduledJobs.map((job) => (
              <ScheduledJobRow key={job.jobId} job={job} />
            ))}
            {upcomingTemplates.map((tpl) => (
              <ScheduledTemplateRow key={tpl.id} template={tpl} />
            ))}
          </div>
        </section>
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
      {!isPending && jobs.length === 0 && scheduledJobs.length === 0 && upcomingTemplates.length === 0 && !error && (
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
              {job.contentType || 'unknown'} · {job.platforms.join(', ') || 'no platform'}
            </p>
            <p className="text-[11px] text-muted-foreground/80 mt-0.5">
              Started {fmtJobTime(job.createdAt)} · Last active {fmtJobTime(job.updatedAt || job.createdAt)}
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

function ScheduledJobRow({ job }: { job: Job }) {
  const startsAt = job.scheduledStartAt;
  return (
    <Card className="border-dashed">
      <CardContent className="py-3 px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href={`/dashboard/jobs/${job.jobId}`} className="text-sm font-medium hover:underline truncate">
                {job.jobId.slice(0, 12)}…
              </Link>
              <Badge variant="outline" className="text-[10px] capitalize">scheduled</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {job.contentType || 'unknown'} · {job.platforms.join(', ') || 'no platform'}
            </p>
            {startsAt && (
              <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                Production starts {fmtJobTime(startsAt)} · credits charge at start
              </p>
            )}
          </div>
          <Link
            href={`/dashboard/jobs/${job.jobId}`}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-xs h-7 px-2 shrink-0')}
          >
            Details →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function ScheduledTemplateRow({ template }: { template: JobTemplate }) {
  return (
    <Card className="border-dashed">
      <CardContent className="py-3 px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link href="/dashboard/templates" className="text-sm font-medium hover:underline truncate">
                {template.name}
              </Link>
              <Badge variant="outline" className="text-[10px]">recurring</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {template.contentType ?? 'custom'} · {template.platforms?.join(', ') || 'no platform'}
            </p>
            {template.nextFireAt && (
              <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                Next run {fmtJobTime(template.nextFireAt)} · moves to In progress when due
              </p>
            )}
          </div>
          <Link
            href={`/dashboard/templates?edit=${template.id}`}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-xs h-7 px-2 shrink-0')}
          >
            Edit →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
