'use client';
/**
 * /dashboard/jobs/[jobId] — Job detail + portal pipeline progress (CPD-98)
 *
 * Polls GET /jobs/:jobId every 5s while the job is active.
 * Renders a portal timeline with per-portal pass/fail/pending status.
 */

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { getJobDetail, type Job, type PortalStatus } from '@/lib/api';

const PORTAL_LABELS: Record<string, string> = {
  portal0:  'P0 — Source validation',
  portal1:  'P1 — Script generation',
  portal1b: 'P1b — Script QA',
  portal2:  'P2 — Video assembly',
  portal3a: 'P3a — Assembly review',
  portal3b: 'P3b — Commitment check',
  portal4:  'P4 — Broadcast QA',
  portal5:  'P5 — Delivery',
};

const ACTIVE_STATUSES = new Set(['queued', 'running']);

function statusColor(s: PortalStatus) {
  if (s === 'pass')    return 'bg-green-500';
  if (s === 'running') return 'bg-blue-500 animate-pulse';
  if (s === 'hold')    return 'bg-yellow-500';
  if (s === 'failed')  return 'bg-destructive';
  if (s === 'skipped') return 'bg-muted/20';
  return 'bg-muted/40'; // pending
}

function JobStatusBadge({ status }: { status: string }) {
  const variant =
    status === 'complete' ? 'default' :
    status === 'failed'   ? 'destructive' :
    status === 'held'     ? 'secondary' :
    'outline';
  return <Badge variant={variant} className="capitalize">{status}</Badge>;
}

export default function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { getToken } = useAuth();
  const [job, setJob]         = useState<Job | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchJob = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await getJobDetail(jobId, token ?? undefined);
      setJob(res.job);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  }, [jobId, getToken]);

  useEffect(() => {
    fetchJob();
  }, [fetchJob]);

  // Poll every 5s while job is active
  useEffect(() => {
    if (!job || !ACTIVE_STATUSES.has(job.status)) return;
    const timer = setInterval(fetchJob, 5000);
    return () => clearInterval(timer);
  }, [job, fetchJob]);

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
        <Link href="/dashboard/jobs" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
          Back to jobs
        </Link>
      </div>
    );
  }

  if (!job) return null;

  const isActive = ACTIVE_STATUSES.has(job.status);

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold font-mono">{job.jobId}</h1>
            <JobStatusBadge status={job.status} />
            {isActive && (
              <span className="text-xs text-muted-foreground animate-pulse">Live</span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {job.contentType} · {job.entryType} ·{' '}
            {new Date(job.createdAt).toLocaleString()}
          </p>
        </div>
        <Link href="/dashboard/jobs" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
          ← Jobs
        </Link>
      </div>

      <Separator />

      {/* Portal pipeline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Portal pipeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(job.portalReports ?? []).map((report) => (
            <div key={report.portal} className="flex items-center gap-3">
              <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', statusColor(report.status))} />
              <span className="text-sm flex-1">{PORTAL_LABELS[report.portal] ?? report.portal}</span>
              {report.score != null && (
                <span className="text-xs text-muted-foreground">{report.score}/100</span>
              )}
              <Badge
                variant={report.status === 'pass' ? 'default' : report.status === 'failed' ? 'destructive' : 'outline'}
                className="text-[10px] capitalize px-1.5"
              >
                {report.status}
              </Badge>
            </div>
          ))}
          {(!job.portalReports || job.portalReports.length === 0) && (
            <p className="text-sm text-muted-foreground">Pipeline not yet started.</p>
          )}
        </CardContent>
      </Card>

      {/* Output */}
      {job.outputUrl && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Output</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <a
              href={job.outputUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full')}
            >
              Download video
            </a>
            {job.thumbnailUrl && (
              <img src={job.thumbnailUrl} alt="Thumbnail" className="w-full rounded-md border mt-2 max-h-48 object-cover" />
            )}
          </CardContent>
        </Card>
      )}

      {/* Publish copy preview */}
      {job.publishCopy?.youtube?.title && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Publish copy</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm font-medium">{job.publishCopy.youtube.title}</p>
            {job.publishCopy.tiktok?.caption && (
              <p className="text-xs text-muted-foreground mt-1">{job.publishCopy.tiktok.caption}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Platforms */}
      {job.platforms.length > 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Platforms:</span>
          {job.platforms.map((p) => (
            <Badge key={p} variant="outline" className="capitalize text-xs">{p}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}
