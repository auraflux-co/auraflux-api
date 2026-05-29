'use client';
/**
 * /myjobs/[jobId] — Job detail + portal pipeline progress (CPD-98)
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
import { formatUserError } from '@/lib/job-labels';
import { getJobDetail, operatorJobAction, saveJobAsTemplate, approveAndPublish, type Job, type PortalStatus, type OperatorAction, type WizardConfig, type PublishResult } from '@/lib/api';
import { SaveTemplateDialog, type SaveTemplateOptions } from '@/components/jobs/save-template-dialog';
import { labelForContentType } from '@/lib/content-types';
import { useRole } from '@/hooks/use-role';

const PLATFORM_ICONS: Record<string, string> = {
  youtube:   '▶',
  tiktok:    '♪',
  instagram: '◎',
};

const ADDON_LABELS: Record<string, string> = {
  tts:            'ElevenLabs TTS',
  heygen:         'AI Avatar',
  shoppable:      'Shoppable tagging',
  wan:            'Video generation',
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

const FEATURE_LABELS: Record<string, string> = {
  script:      'Script generation',
  tts:         'TTS narration',
  commentary:  'Show commentary',
  generation:  'Video generation',
  burn_images: 'Image overlays',
};

function ScriptCard({ script }: { script: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Generated script</CardTitle>
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {open ? 'Hide ▲' : 'Show ▼'}
          </button>
        </div>
      </CardHeader>
      {open && (
        <CardContent>
          <pre className="text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground bg-muted/30 rounded-md p-3 max-h-72 overflow-y-auto">
            {script}
          </pre>
        </CardContent>
      )}
    </Card>
  );
}

function WizardConfigReview({ wc }: { wc: WizardConfig }) {
  const ff = wc.formFactor === 'short' || wc.templateId === 'short-form' ? 'Short-form (9:16)' : 'Long-form (16:9)';
  const entryLabels: Record<string, string> = { fetch: 'URL fetch', upload: 'File upload', create: 'Generated' };
  const allBadges = [
    ...(wc.addOns ?? []).map((a) => ADDON_LABELS[a] ?? a),
    ...(wc.activeFeatures ?? []).map((f) => FEATURE_LABELS[f] ?? f),
  ];
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
        {wc.topic && (
          <>
            <span className="text-muted-foreground">Topic</span>
            <span className="truncate" title={wc.topic}>{wc.topic}</span>
          </>
        )}
        {wc.tone && (
          <>
            <span className="text-muted-foreground">Tone</span>
            <span className="capitalize">{wc.tone}</span>
          </>
        )}
        {wc.durationMins != null && (
          <>
            <span className="text-muted-foreground">Duration</span>
            <span>{wc.durationMins} min</span>
          </>
        )}
        {wc.planTier && (
          <>
            <span className="text-muted-foreground">Plan tier</span>
            <span className="capitalize">{wc.planTier}</span>
          </>
        )}
        {wc.creditCost != null && (
          <>
            <span className="text-muted-foreground">Credit cost</span>
            <span>{wc.creditCost} credits</span>
          </>
        )}
        <span className="text-muted-foreground">Publish</span>
        <span className="capitalize">
          {wc.publishMode}{wc.scheduledAt ? ` — ${new Date(wc.scheduledAt).toLocaleDateString()}` : ''}
        </span>
      </div>
      {allBadges.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">Production features</p>
          <div className="flex flex-wrap gap-1">
            {allBadges.map((label) => (
              <Badge key={label} variant="outline" className="text-[10px] px-1.5">
                {label}
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
  const { getToken, isLoaded } = useAuth();
  const { isSuperAdmin }         = useRole();
  const [job, setJob]               = useState<Job | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startAction]    = useTransition();
  const [savedAsTemplate, setSavedAsTemplate] = useState(false);
  const [savingTemplate, setSavingTemplate]   = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [approving, setApproving]             = useState(false);
  const [approveError, setApproveError]       = useState<string | null>(null);
  const [approveResult, setApproveResult]     = useState<Record<string, unknown> | null>(null);

  async function handleSaveAsTemplate(opts: SaveTemplateOptions) {
    if (!job) return;
    setSavingTemplate(true);
    try {
      const token = await getToken();
      await saveJobAsTemplate(job.jobId, opts.name, {
        description: opts.description,
        recurrenceType: opts.recurrenceType,
        recurrenceDay: opts.recurrenceDay,
        recurrenceTime: opts.recurrenceTime,
      }, token ?? undefined);
      setSavedAsTemplate(true);
      setShowSaveTemplate(false);
    } catch {
      // non-fatal
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleApprovePublish() {
    setApproveError(null);
    setApproving(true);
    try {
      const token = await getToken();
      const res = await approveAndPublish(jobId, job?.platforms, token ?? undefined);
      setApproveResult(res.platforms);
      await fetchJob();
    } catch (e: unknown) {
      setApproveError(e instanceof Error ? e.message : 'Publish failed. Please try again.');
    } finally {
      setApproving(false);
    }
  }

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
    if (!isLoaded) return;
    fetchJob();
  }, [fetchJob, isLoaded]);

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
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
        <Link href="/myjobs" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
          Back to jobs
        </Link>
      </div>
    );
  }

  if (!job) return null;

  const isActive    = ACTIVE_STATUSES.has(job.status);
  const isComplete  = job.status === 'complete';
  const isStaged    = job.status === 'staged';
  const isReadyForReview = (isComplete || isStaged) && !!job.outputUrl;
  const runningPortal = job.portalReports?.find((r) => r.status === 'running');
  const passedCount   = job.portalReports?.filter((r) => r.status === 'pass').length ?? 0;
  const totalPortals  = job.portalReports?.length ?? 0;
  const avgScore      = job.portalReports && job.portalReports.filter((r) => r.score != null).length > 0
    ? Math.round(job.portalReports.filter((r) => r.score != null).reduce((s, r) => s + (r.score ?? 0), 0) / job.portalReports.filter((r) => r.score != null).length)
    : null;

  return (
    <div className="space-y-5 max-w-2xl">

      {/* ── Building state hero ── */}
      {isActive && (
        <div className="rounded-xl border bg-gradient-to-b from-muted/40 to-background px-5 py-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-xs font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                  {job.status === 'queued' ? 'Queued' : 'In production'}
                </span>
              </div>
              <h1 className="text-xl font-semibold">
                {job.status === 'queued' ? 'Getting ready…' : 'Building your video'}
              </h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {job.status === 'queued'
                  ? 'Your job is in the queue and will start shortly.'
                  : runningPortal
                    ? `Running ${PORTAL_LABELS[runningPortal.portal] ?? runningPortal.portal}`
                    : 'Processing through the production pipeline.'}
              </p>
            </div>
            <Link href="/myjobs/active" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}>
              ← All jobs
            </Link>
          </div>

          {/* Pipeline progress steps */}
          {totalPortals > 0 && (
            <div className="space-y-2">
              {/* Progress bar */}
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-700"
                  style={{ width: `${totalPortals > 0 ? Math.round((passedCount / totalPortals) * 100) : 0}%` }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground text-right">{passedCount} of {totalPortals} stages complete</p>

              {/* Step list */}
              <div className="space-y-1.5 pt-1">
                {job.portalReports!.map((report, i) => (
                  <div key={report.portal} className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 transition-colors',
                    report.status === 'running' ? 'bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800' : '',
                  )}>
                    <div className={cn(
                      'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
                      report.status === 'pass'    ? 'bg-green-500 text-white' :
                      report.status === 'running' ? 'bg-blue-500 text-white animate-pulse' :
                      report.status === 'failed'  ? 'bg-destructive text-white' :
                      report.status === 'skipped' ? 'bg-muted text-muted-foreground' :
                      'bg-muted/60 text-muted-foreground',
                    )}>
                      {report.status === 'pass'    ? '✓' :
                       report.status === 'failed'  ? '✕' :
                       report.status === 'running' ? '…' :
                       report.status === 'skipped' ? '—' :
                       String(i + 1)}
                    </div>
                    <span className={cn(
                      'text-sm flex-1',
                      report.status === 'running' ? 'font-medium' : 'text-muted-foreground',
                    )}>
                      {PORTAL_LABELS[report.portal] ?? report.portal}
                    </span>
                    {report.score != null && (
                      <span className={cn(
                        'text-xs font-semibold tabular-nums',
                        report.score >= 80 ? 'text-green-600' : report.score >= 60 ? 'text-yellow-600' : 'text-destructive',
                      )}>
                        {report.score}/100
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {totalPortals === 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/40 animate-pulse" />
              Pipeline initialising…
            </div>
          )}
        </div>
      )}

      {/* ── Ready for review hero ── */}
      {isReadyForReview && (
        <div className="rounded-xl border-2 border-green-200 dark:border-green-800 bg-gradient-to-b from-green-50/50 to-background dark:from-green-950/20 px-5 py-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                <span className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">Ready for review</span>
                {avgScore != null && (
                  <span className={cn(
                    'text-xs font-bold px-2 py-0.5 rounded-full',
                    avgScore >= 80 ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' :
                    avgScore >= 60 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' :
                    'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
                  )}>
                    {avgScore}/100
                  </span>
                )}
              </div>
              <h1 className="text-xl font-semibold">Your video is ready</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Review the output below, then approve and publish when ready.
              </p>
            </div>
            <Link href="/myjobs/history" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}>
              ← History
            </Link>
          </div>

          {/* Video preview */}
          {job.outputUrl && (
            <div className="space-y-3">
              <video
                src={job.outputUrl}
                controls
                preload="metadata"
                poster={job.thumbnailUrl ?? undefined}
                className="w-full rounded-lg border bg-black aspect-video object-contain"
              />
            </div>
          )}

          {/* Review CTAs */}
          <div className="flex flex-col sm:flex-row gap-2">
            {job.status === 'staged' ? (
              <Button
                size="sm"
                className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                onClick={handleApprovePublish}
                disabled={approving}
              >
                {approving ? 'Publishing…' : `✓ Approve & publish to ${job.platforms.join(', ')}`}
              </Button>
            ) : (
              <a
                href={job.outputUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ size: 'sm' }), 'flex-1 text-center bg-green-600 hover:bg-green-700 text-white border-green-600')}
              >
                ✓ Open video
              </a>
            )}
            <a
              href={job.outputUrl!}
              download
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'flex-1 text-center')}
            >
              ↓ Download
            </a>
            {!savedAsTemplate ? (
              <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowSaveTemplate(true)} disabled={savingTemplate}>
                ☆ Save as template
              </Button>
            ) : (
              <Badge variant="default" className="text-[10px] self-center mx-auto">Saved as template</Badge>
            )}
          </div>

          {approveError && (
            <p className="text-xs text-destructive bg-destructive/10 rounded px-3 py-2">{approveError}</p>
          )}
          {approveResult && (
            <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 px-3 py-2 text-xs text-green-700 dark:text-green-300">
              ✓ Published. Check your platforms for live links.
            </div>
          )}
        </div>
      )}

      {/* ── Standard (non-active, non-staged) header ── */}
      {!isActive && !isReadyForReview && (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold font-mono">{job.jobId}</h1>
              <JobStatusBadge status={job.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              {labelForContentType(job.contentType)} · {job.entryType} ·{' '}
              {new Date(job.createdAt).toLocaleString()}
            </p>
          </div>
          <Link href="/myjobs" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
            ← Jobs
          </Link>
        </div>
      )}

      <Separator />

      {/* Portal pipeline — shown collapsed when complete, full when active */}
      {!isActive && (
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
      )}

      {/* Thumbnail (non-review path, e.g. published) */}
      {!isReadyForReview && job.outputUrl && (
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

      {/* Generated script — only shown when user selected script generation for this job */}
      {job.filledScript && job.wizardConfig?.activeFeatures?.includes('script') && (
        <ScriptCard script={job.filledScript} />
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

      {/* Job spec card — visible for all statuses so customer can see what is locked in (CPD-112) */}
      {job.wizardConfig && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm">Job spec</CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">What is locked in for this job</p>
              </div>
              <div className="flex items-center gap-2">
                {job.status === 'complete' && (
                  savedAsTemplate ? (
                    <Badge variant="default" className="text-[10px]">Saved as template</Badge>
                  ) : (
                    <Button size="sm" variant="outline" className="text-[10px] h-6 px-2" onClick={() => setShowSaveTemplate(true)} disabled={savingTemplate}>
                      Save as template
                    </Button>
                  )
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <WizardConfigReview wc={job.wizardConfig} />
          </CardContent>
        </Card>
      )}

      {/* Operator actions (CPD-104) */}
      {isSuperAdmin && (
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
              <p className="text-xs text-destructive">{formatUserError(actionError)}</p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Retry: re-runs full pipeline. Force advance: skips current blocked portal. Rollback: resets to held state.
            </p>
          </CardContent>
        </Card>
      )}

      <SaveTemplateDialog
        open={showSaveTemplate}
        defaultName={job ? `Template from ${job.jobId.slice(0, 8)}` : 'My template'}
        saving={savingTemplate}
        onClose={() => setShowSaveTemplate(false)}
        onSave={handleSaveAsTemplate}
      />
    </div>
  );
}
