'use client';
/**
 * /dashboard/jobs/[jobId] — Job detail + portal pipeline progress (CPD-98)
 *
 * Polls GET /jobs/:jobId every 5s while the job is active.
 * Renders a portal timeline with per-portal pass/fail/pending status.
 */

import { useEffect, useState, useCallback, useTransition } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { buttonVariants, Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { getJobDetail, operatorJobAction, type Job, type PortalStatus, type OperatorAction, type WizardConfig, type PublishResult } from '@/lib/api';
import { labelForContentType } from '@/lib/content-types';
import { useRole } from '@/hooks/use-role';

const PLATFORM_ICONS: Record<string, string> = {
  youtube:   '▶',
  tiktok:    '♪',
  instagram: '◎',
};

const ADDON_LABELS: Record<string, string> = {
  tts:            'ElevenLabs TTS',
  heygen:         'HeyGen avatar',
  shoppable:      'Shoppable tagging',
  wan:            'AI video generation',
  clipSourcing:   'Scene selection',
  showCommentary: 'Narrative narration',
  branding:       'Brand overlay',
  imageBurn:      'Image burn',
  dynamicOverlays:'Dynamic overlays',
};

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

function WizardConfigReview({ wc }: { wc: WizardConfig }) {
  const ff = wc.formFactor === 'short' || wc.templateId === 'short-form' ? 'Short-form (9:16)' : 'Long-form (16:9)';
  const entryLabels: Record<string, string> = { fetch: 'URL fetch', upload: 'File upload', create: 'AI generated' };
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        <span className="text-muted-foreground">Format</span>
        <span>{ff}</span>
        {wc.entryType && (
          <>
            <span className="text-muted-foreground">Source</span>
            <span>{entryLabels[wc.entryType] ?? wc.entryType}</span>
          </>
        )}
        {wc.contentType && (
          <>
            <span className="text-muted-foreground">Content type</span>
            <span>{labelForContentType(wc.contentType)}</span>
          </>
        )}
        <span className="text-muted-foreground">Publish</span>
        <span className="capitalize">
          {wc.publishMode}{wc.scheduledAt ? ` — ${new Date(wc.scheduledAt).toLocaleDateString()}` : ''}
        </span>
      </div>
      {wc.addOns.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">Features applied</p>
          <div className="flex flex-wrap gap-1">
            {wc.addOns.map((a) => (
              <Badge key={a} variant="outline" className="text-[10px] px-1.5">
                {ADDON_LABELS[a] ?? a}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {wc.platforms.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">Platforms</p>
          <div className="flex gap-1">
            {wc.platforms.map((p) => (
              <Badge key={p} variant="secondary" className="text-[10px] capitalize px-1.5">
                {PLATFORM_ICONS[p] ?? '•'} {p}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const { isOperator } = useRole();
  const [job, setJob]               = useState<Job | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startAction]    = useTransition();

  async function handleOperatorAction(action: OperatorAction) {
    setActionError(null);
    startAction(async () => {
      try {
        const token = await getToken();
        await operatorJobAction(jobId, action, token ?? undefined);
        await fetchJob();
      } catch (e: unknown) {
        setActionError(e instanceof Error ? e.message : `Failed to ${action} job`);
      }
    });
  }

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
            {labelForContentType(job.contentType)} · {job.entryType} ·{' '}
            {new Date(job.createdAt).toLocaleString()}
          </p>
        </div>
        <Link href={job.status === 'complete' ? '/dashboard/jobs/history' : '/dashboard/jobs/active'} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
          ← {job.status === 'complete' ? 'History' : 'Active'}
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

      {/* Publish copy */}
      {job.publishCopy && Object.keys(job.publishCopy).length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Publish copy</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {job.publishCopy.youtube && (
              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">YouTube</p>
                {job.publishCopy.youtube.title && (
                  <p className="text-sm font-medium">{job.publishCopy.youtube.title}</p>
                )}
                {job.publishCopy.youtube.description && (
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{job.publishCopy.youtube.description}</p>
                )}
                {job.publishCopy.youtube.tags && job.publishCopy.youtube.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {job.publishCopy.youtube.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px] px-1.5">{tag}</Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
            {job.publishCopy.tiktok && (
              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">TikTok</p>
                {job.publishCopy.tiktok.caption && (
                  <p className="text-xs text-muted-foreground">{job.publishCopy.tiktok.caption}</p>
                )}
                {job.publishCopy.tiktok.hashtags && job.publishCopy.tiktok.hashtags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {job.publishCopy.tiktok.hashtags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px] px-1.5">{tag}</Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
            {job.publishCopy.instagram && (
              <div className="space-y-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Instagram</p>
                {job.publishCopy.instagram.caption && (
                  <p className="text-xs text-muted-foreground">{job.publishCopy.instagram.caption}</p>
                )}
                {job.publishCopy.instagram.hashtags && job.publishCopy.instagram.hashtags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {job.publishCopy.instagram.hashtags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px] px-1.5">{tag}</Badge>
                    ))}
                  </div>
                )}
              </div>
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

      {/* Published links (CPD-112) */}
      {job.publishResults && job.publishResults.filter((r) => r.status === 'published').length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Published</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {job.publishResults.filter((r) => r.status === 'published').map((r) => (
              <div key={r.platform} className="flex items-center justify-between">
                <span className="text-sm capitalize">{PLATFORM_ICONS[r.platform] ?? '•'} {r.platform}</span>
                <div className="flex items-center gap-2">
                  {r.publishedAt && (
                    <span className="text-xs text-muted-foreground">{new Date(r.publishedAt).toLocaleDateString()}</span>
                  )}
                  {r.driveUrl && (
                    <a
                      href={r.driveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-xs h-7 px-2')}
                    >
                      View ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Selection review — what customer configured (CPD-112) */}
      {job.status === 'complete' && job.wizardConfig && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">What you selected</CardTitle>
              <Badge variant="outline" className="text-[10px]">Templates — coming soon</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <WizardConfigReview wc={job.wizardConfig} />
          </CardContent>
        </Card>
      )}

      {/* Operator actions (CPD-104) */}
      {isOperator && (
        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Operator actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm" variant="outline"
                disabled={isPending || !['failed', 'held', 'complete'].includes(job.status)}
                onClick={() => handleOperatorAction('retry')}
              >
                Retry (full re-run)
              </Button>
              <Button
                size="sm" variant="outline"
                disabled={isPending || !['failed', 'held', 'running'].includes(job.status)}
                onClick={() => handleOperatorAction('advance')}
              >
                Force advance
              </Button>
              <Button
                size="sm" variant="destructive"
                disabled={isPending}
                onClick={() => handleOperatorAction('rollback')}
              >
                Rollback
              </Button>
            </div>
            {actionError && (
              <p className="text-xs text-destructive">{actionError}</p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Retry: re-runs full pipeline. Force advance: skips current blocked portal. Rollback: resets to held state.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
