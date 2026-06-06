'use client';
/**
 * /myjobs/active — In-flight jobs (CPD-112)
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
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { jobStatusLabel, jobDisplayTitle, platformListLabel, formatUserError } from '@/lib/job-labels';
import { labelForContentType } from '@/lib/content-types';

const ACTIVE_STATUSES = new Set(['queued', 'running', 'held', 'failed', 'credit_paused']);
const SCHEDULED_JOB_STATUSES = new Set(['queued_scheduled']);
const POLL_MS = 15_000;

function statusColor(s: string) {
  if (s === 'running')       return 'bg-blue-500 animate-pulse';
  if (s === 'queued')        return 'bg-muted/60';
  if (s === 'held')          return 'bg-yellow-500';
  if (s === 'failed')        return 'bg-destructive';
  if (s === 'credit_paused') return 'bg-orange-500';
  return 'bg-muted/30';
}

function statusCardStyle(s: string): string {
  if (s === 'failed')        return 'border-l-[3px] border-l-red-500/80 bg-red-950/10';
  if (s === 'held')          return 'border-l-[3px] border-l-yellow-500/80 bg-yellow-950/10';
  if (s === 'credit_paused') return 'border-l-[3px] border-l-orange-500/80 bg-orange-950/10';
  if (s === 'running')       return 'border-l-[3px] border-l-blue-500/60';
  return '';
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'failed'        ? 'bg-red-950/60 text-red-400 border border-red-800/60'   :
    status === 'held'          ? 'bg-yellow-950/60 text-yellow-400 border border-yellow-800/60' :
    status === 'credit_paused' ? 'bg-orange-950/60 text-orange-400 border border-orange-800/60' :
    status === 'running'       ? 'bg-blue-950/60 text-blue-400 border border-blue-800/60' :
    'bg-muted/60 text-muted-foreground border border-border';
  return (
    <span className={cn('inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded', cls)}>
      <span className={cn('w-1.5 h-1.5 rounded-full inline-block', statusColor(status))} />
      {jobStatusLabel(status)}
    </span>
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
  const { isSuperAdmin }         = useRole();
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

  // Failed = self-healing system error, never surfaces to customers.
  // Superadmin sees all; customers only see jobs they can act on or are in flight.
  const needsAttention = jobs.filter((j) =>
    j.status === 'credit_paused' ||
    j.status === 'held' ||
    (isSuperAdmin && j.status === 'failed')
  );
  const inProgress = jobs.filter((j) =>
    j.status === 'queued' || j.status === 'running' ||
    (isSuperAdmin && j.status === 'failed')
  ).filter((j) => isSuperAdmin || j.status !== 'failed');

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="Active Jobs"
        subtitle="Scheduled, in progress, and jobs that need your attention"
      >
        <button
          onClick={fetchJobs}
          disabled={isPending}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), isPending && 'opacity-50')}
        >
          {isPending ? 'Refreshing…' : 'Refresh'}
        </button>
        <Link href="/myjobs/new" className={cn(buttonVariants({ size: 'sm' }))}>
          + New job
        </Link>
      </PageHeader>

      {error && (
        <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
      )}
      {actionError && (
        <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(actionError)}</p>
      )}

      {(scheduledJobs.length > 0 || upcomingTemplates.length > 0) && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="af-subhead">Scheduled</h2>
            <span className="text-xs bg-muted/60 text-muted-foreground px-1.5 py-0.5 rounded font-medium">
              {scheduledJobs.length + upcomingTemplates.length}
            </span>
          </div>
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

      {/* Needs attention — customer-actionable only (CPD-588) */}
      {needsAttention.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="af-subhead text-yellow-400">Needs attention</h2>
            <span className="text-xs bg-yellow-950/60 text-yellow-400 border border-yellow-800/60 px-1.5 py-0.5 rounded font-medium">
              {needsAttention.length}
            </span>
          </div>
          <div className="space-y-2">
            {needsAttention.map((job) => (
              <JobRow key={job.jobId} job={job} isSuperAdmin={isSuperAdmin} onAction={handleAction} />
            ))}
          </div>
        </section>
      )}

      {/* In progress */}
      {inProgress.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="af-subhead">In progress</h2>
            <span className="text-xs bg-blue-950/60 text-blue-400 border border-blue-800/60 px-1.5 py-0.5 rounded font-medium">
              {inProgress.length}
            </span>
          </div>
          <div className="space-y-2">
            {inProgress.map((job) => (
              <JobRow key={job.jobId} job={job} isSuperAdmin={isSuperAdmin} onAction={handleAction} />
            ))}
          </div>
        </section>
      )}

      {/* Empty */}
      {!isPending && jobs.length === 0 && scheduledJobs.length === 0 && upcomingTemplates.length === 0 && !error && (
        <EmptyState
          title="No active jobs right now"
          description="Jobs you create will appear here while they're running."
          action={{ label: 'Create a job', href: '/myjobs/new' }}
        />
      )}
    </PageShell>
  );
}

function JobRow({
  job,
  isSuperAdmin,
  onAction,
  stale = false,
}: {
  job: Job;
  isSuperAdmin: boolean;
  onAction: (jobId: string, action: OperatorAction) => void;
  stale?: boolean;
}) {
  const currentPortal = job.portalReports?.find((p) => p.status === 'running' || p.status === 'hold' || p.status === 'failed');
  const portalLabel = currentPortal
    ? currentPortal.portal.replace('portal', 'P')
    : null;
  const passedCount = job.portalReports?.filter((p) => p.status === 'pass').length ?? 0;
  const totalPortals = job.portalReports?.length ?? 0;

  return (
    <div className={cn(
      'rounded-xl border bg-card px-4 py-3.5 transition-all',
      'hover:border-primary/20 hover:shadow-sm',
      statusCardStyle(job.status),
    )}>
      <div className="flex items-start gap-3">
        {/* Portal progress strip */}
        {(job.portalReports ?? []).length > 0 && (
          <div className="flex flex-col gap-0.5 mt-0.5 shrink-0">
            {(job.portalReports ?? []).map((p) => (
              <span
                key={p.portal}
                title={p.portal}
                className={cn('w-1.5 h-3 rounded-[2px]', statusColor(p.status))}
              />
            ))}
          </div>
        )}

        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/myjobs/${job.jobId}`}
              className="text-sm font-semibold text-foreground hover:text-primary transition-colors truncate max-w-[280px]"
            >
              {jobDisplayTitle(job)}
            </Link>
            <StatusBadge status={job.status} />
            {portalLabel && job.status === 'running' && (
              <span className="text-[10px] text-blue-400/80 font-medium">{portalLabel}</span>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-muted-foreground">
              {labelForContentType(job.contentType ?? '')}
            </span>
            {job.platforms.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {platformListLabel(job.platforms)}
              </span>
            )}
            {totalPortals > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {passedCount}/{totalPortals} stages
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <p className="text-[11px] text-muted-foreground/60">
              Started {fmtJobTime(job.createdAt)}
            </p>
            {stale && (
              <span className="text-[10px] font-medium bg-orange-950/60 text-orange-400 border border-orange-800/60 px-1.5 py-0.5 rounded">
                Running longer than expected
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Link
            href={`/myjobs/${job.jobId}`}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-xs h-7 px-2.5')}
          >
            Details →
          </Link>
          {isSuperAdmin && (job.status === 'held' || job.status === 'failed') && (
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
    </div>
  );
}

function ScheduledJobRow({ job }: { job: Job }) {
  const startsAt = job.scheduledStartAt;
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-card/60 px-4 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Link href={`/myjobs/${job.jobId}`} className="text-sm font-semibold text-foreground hover:text-primary transition-colors truncate">
            {jobDisplayTitle(job)}
          </Link>
          <span className="text-[10px] font-medium border border-border/60 text-muted-foreground px-1.5 py-0.5 rounded">
            Scheduled
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {labelForContentType(job.contentType ?? '')} · {platformListLabel(job.platforms)}
        </p>
        {startsAt && (
          <p className="text-[11px] text-muted-foreground/60">
            Starts {fmtJobTime(startsAt)}
          </p>
        )}
      </div>
      <Link
        href={`/myjobs/${job.jobId}`}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-xs h-7 px-2.5 shrink-0')}
      >
        Details →
      </Link>
    </div>
  );
}

function ScheduledTemplateRow({ template }: { template: JobTemplate }) {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-card/60 px-4 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/templates" className="text-sm font-semibold text-foreground hover:text-primary transition-colors truncate">
            {template.name}
          </Link>
          <span className="text-[10px] font-medium border border-border/60 text-muted-foreground px-1.5 py-0.5 rounded">
            Recurring
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {template.contentType ?? 'custom'} · {template.platforms?.join(', ') || 'no platform'}
        </p>
        {template.nextFireAt && (
          <p className="text-[11px] text-muted-foreground/60">
            Next run {fmtJobTime(template.nextFireAt)}
          </p>
        )}
      </div>
      <Link
        href={`/templates?edit=${template.id}`}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-xs h-7 px-2.5 shrink-0')}
      >
        Edit →
      </Link>
    </div>
  );
}
