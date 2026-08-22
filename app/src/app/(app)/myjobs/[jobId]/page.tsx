'use client';
/**
 * /myjobs/[jobId] — Job detail (CPD-98, CPD-488)
 *
 * Full redesign: friendly 4-stage stepper, compact spec strip, status heroes
 * for every state, collapsed admin pipeline detail, horizontal platform cards.
 * Every section conditionally renders — only visible if data exists.
 */

import { useEffect, useState, useCallback, useTransition } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/lib/clerk-compat';
import Link from 'next/link';
import { buttonVariants, Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatUserError, platformLabel } from '@/lib/job-labels';
import {
  getJobDetail, operatorJobAction, saveJobAsTemplate, approveAndPublish,
  getThumbnailCandidates, approveThumbnail, getStagingAssets, listConnectedAccounts,
  type Job, type OperatorAction, type ThumbnailCandidate, type StagingAssets,
  type ConnectedAccount,
} from '@/lib/api';
import { SaveTemplateDialog, type SaveTemplateOptions } from '@/components/jobs/save-template-dialog';
import { labelForContentType } from '@/lib/content-types';
import { useRole } from '@/hooks/use-role';

// ── Constants ──────────────────────────────────────────────────────────────────

const PLATFORM_ICONS: Record<string, string> = {
  youtube:   '▶',
  tiktok:    '♪',
  instagram: '◎',
};

const PLATFORM_BADGE_CLASSES: Record<string, string> = {
  youtube:   'bg-red-950/60 text-red-400 border border-red-800/50',
  tiktok:    'bg-cyan-950/60 text-cyan-300 border border-cyan-800/50',
  instagram: 'bg-purple-950/60 text-purple-400 border border-purple-800/50',
  twitter:   'bg-sky-950/60 text-sky-400 border border-sky-800/50',
  facebook:  'bg-blue-950/60 text-blue-400 border border-blue-800/50',
  linkedin:  'bg-blue-950/60 text-blue-300 border border-blue-800/50',
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

const FRIENDLY_STAGES: ReadonlyArray<{ id: string; label: string; portals: readonly string[] }> = [
  { id: 'source',  label: 'Sourcing content',   portals: ['portal0'] },
  { id: 'script',  label: 'Writing the script',  portals: ['portal1', 'portal1b'] },
  { id: 'build',   label: 'Building the video',  portals: ['portal2', 'portal3a', 'portal3b', 'portal4'] },
  { id: 'publish', label: 'Publishing',           portals: ['portal5'] },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

type StageStatus = 'pass' | 'running' | 'failed' | 'hold' | 'pending';

function getStageStatus(stagePortals: readonly string[], portalReports: Job['portalReports']): StageStatus {
  if (!portalReports || portalReports.length === 0) return 'pending';
  const reports = portalReports.filter((r) => stagePortals.includes(r.portal));
  if (reports.length === 0) return 'pending';
  if (reports.some((r) => r.status === 'running')) return 'running';
  if (reports.some((r) => r.status === 'failed'))  return 'failed';
  if (reports.some((r) => r.status === 'hold'))    return 'hold';
  if (reports.every((r) => r.status === 'pass' || r.status === 'skipped')) return 'pass';
  return 'pending';
}

function stageCircle(status: StageStatus, index: number) {
  const base = 'relative z-10 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 shrink-0';
  const style =
    status === 'pass'    ? 'bg-emerald-500 border-emerald-500 text-white' :
    status === 'running' ? 'bg-blue-500 border-blue-500 text-white animate-pulse' :
    status === 'failed'  ? 'bg-red-500 border-red-500 text-white' :
    status === 'hold'    ? 'bg-amber-500 border-amber-500 text-white' :
    'bg-background border-muted/60 text-muted-foreground';
  const icon =
    status === 'pass'    ? '✓' :
    status === 'failed'  ? '✕' :
    status === 'running' ? '…' :
    String(index + 1);
  return { className: cn(base, style), icon };
}

// ── Sub-components ─────────────────────────────────────────────────────────────

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

function SpecStrip({ job }: { job: Job }) {
  const wc  = job.wizardConfig;
  const ff  = !wc?.formFactor ? null : wc.formFactor === 'short' ? 'Short-form' : 'Long-form';
  const parts = [
    wc?.contentType ? labelForContentType(wc.contentType) : null,
    ff,
    job.platforms.length > 0
      ? job.platforms.map(platformLabel).join(', ')
      : null,
    new Date(job.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
  ].filter(Boolean) as string[];

  const topic = wc?.topic
    ? (wc.topic.length > 50 ? wc.topic.slice(0, 50) + '…' : wc.topic)
    : null;

  const all = topic ? [topic, ...parts] : parts;
  if (all.length === 0) return null;

  return (
    <p className="text-xs text-muted-foreground/70 mt-1.5 truncate">
      {all.join(' · ')}
    </p>
  );
}

function FriendlyStepper({ portalReports }: { portalReports: Job['portalReports'] }) {
  const activeLabel = FRIENDLY_STAGES.find((s) => {
    const st = getStageStatus(s.portals, portalReports);
    return st === 'running' || st === 'hold';
  })?.label ?? null;

  return (
    <div className="space-y-2.5">
      <div className="relative">
        <div className="absolute top-4 left-[12.5%] right-[12.5%] h-0.5 bg-muted/40 rounded-full" />
        <div className="relative grid grid-cols-4 text-center gap-1">
          {FRIENDLY_STAGES.map((stage, i) => {
            const status = getStageStatus(stage.portals, portalReports);
            const { className, icon } = stageCircle(status, i);
            return (
              <div key={stage.id} className="flex flex-col items-center gap-1.5">
                <div className={className}>{icon}</div>
                <p className={cn(
                  'text-[10px] leading-tight font-medium',
                  status === 'running' ? 'text-blue-500 dark:text-blue-400' :
                  status === 'pass'    ? 'text-emerald-600 dark:text-emerald-400' :
                  status === 'failed'  ? 'text-red-600 dark:text-red-400' :
                  status === 'hold'    ? 'text-amber-600 dark:text-amber-400' :
                  'text-muted-foreground',
                )}>
                  {stage.label}
                </p>
              </div>
            );
          })}
        </div>
      </div>
      {activeLabel && (
        <p className="text-xs text-center text-muted-foreground">
          Working on: <span className="font-medium text-foreground">{activeLabel}</span>
        </p>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

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
  // CPD-512: thumbnail picker
  const [thumbCandidates, setThumbCandidates] = useState<ThumbnailCandidate[] | null>(null);
  const [thumbApproving, setThumbApproving]   = useState(false);
  const [thumbApproved, setThumbApproved]     = useState<string | null>(null);
  // CPD-505: staging review — editable publish metadata + script + QA + account confirmation
  const [stagingAssets, setStagingAssets]     = useState<StagingAssets | null>(null);
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccount[]>([]);
  const [reviewTitle,       setReviewTitle]       = useState('');
  const [reviewDesc,        setReviewDesc]         = useState('');
  const [reviewTags,        setReviewTags]         = useState('');
  const [reviewPrivacy,     setReviewPrivacy]      = useState<'public'|'unlisted'|'private'>('public');
  const [reviewTiktok,      setReviewTiktok]       = useState('');
  const [reviewInstagram,   setReviewInstagram]    = useState('');
  const [reviewEdited,      setReviewEdited]       = useState(false);
  const [scriptExpanded,    setScriptExpanded]     = useState(false);

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
      const publishMeta = {
        title:            reviewTitle.trim()     || undefined,
        description:      reviewDesc.trim()      || undefined,
        tags:             reviewTags.trim() ? reviewTags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        privacyStatus:    reviewPrivacy          || undefined,
        tiktokCaption:    reviewTiktok.trim()    || undefined,
        instagramCaption: reviewInstagram.trim() || undefined,
      };
      const res = await approveAndPublish(
        jobId,
        { platforms: job?.platforms, publishMeta },
        token ?? undefined,
      );
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

  useEffect(() => {
    if (!job || !ACTIVE_STATUSES.has(job.status)) return;
    const timer = setInterval(fetchJob, 5000);
    return () => clearInterval(timer);
  }, [job, fetchJob]);

  // CPD-505: fetch staging assets + connected accounts when job is staged
  useEffect(() => {
    if (!job || job.status !== 'staged') return;
    if (stagingAssets) return;
    (async () => {
      try {
        const token = await getToken();
        const [sa, ca] = await Promise.all([
          getStagingAssets(jobId, token ?? undefined),
          listConnectedAccounts(token ?? undefined),
        ]);
        setStagingAssets(sa);
        setConnectedAccounts(ca.accounts || []);
        // Pre-fill editable fields: customer-provided first, then AI publishCopy fallback
        const pm = sa.publishMeta;
        const pc = sa.output?.publishCopy;
        setReviewTitle(pm.title || pc?.youtube?.title || '');
        setReviewDesc(pm.description || pc?.youtube?.description || '');
        setReviewTags((pm.tags?.join(', ')) || (pc?.youtube?.tags?.join(', ')) || '');
        setReviewPrivacy((pm.privacyStatus as 'public'|'unlisted'|'private') || 'public');
        setReviewTiktok(pm.tiktokCaption || pc?.tiktok?.caption || '');
        setReviewInstagram(pm.instagramCaption || pc?.instagram?.caption || '');
        setReviewEdited(false);
      } catch { /* non-fatal */ }
    })();
  }, [job, jobId, getToken, stagingAssets]);

  // CPD-512: fetch thumbnail candidates when job is complete/staged and not yet approved
  useEffect(() => {
    if (!job) return;
    if (job.status !== 'staged' && job.status !== 'complete') return;
    if (thumbCandidates !== null || thumbApproved) return;
    (async () => {
      try {
        const token = await getToken();
        const res = await getThumbnailCandidates(jobId, token ?? undefined);
        if (res.candidates?.length) setThumbCandidates(res.candidates);
        if (res.status === 'approved' && res.r2Url) setThumbApproved(res.r2Url);
      } catch {
        // thumbnail stage not initiated yet — ignore silently
      }
    })();
  }, [job, jobId, getToken, thumbCandidates, thumbApproved]);

  async function handleSelectThumbnail(candidate: ThumbnailCandidate) {
    setThumbApproving(true);
    try {
      const token = await getToken();
      await approveThumbnail(jobId, { method: candidate.method, candidateIndex: candidate.index }, token ?? undefined);
      setThumbApproved(candidate.url);
    } catch {
      // non-fatal — thumbnail approval is optional
    } finally {
      setThumbApproving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 animate-pulse p-6">
        <div className="h-8 w-48 bg-muted rounded" />
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-3/4 bg-muted rounded" />
        <div className="h-32 w-full bg-muted rounded-xl" />
        <div className="h-4 w-full bg-muted rounded" />
        <div className="h-4 w-2/3 bg-muted rounded" />
      </div>
    );
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

  const isActive         = ACTIVE_STATUSES.has(job.status);
  const isComplete       = job.status === 'complete';
  const isStaged         = job.status === 'staged';
  const isReadyForReview = (isComplete || isStaged) && !!job.outputUrl;
  const hasPortals       = (job.portalReports?.length ?? 0) > 0;
  const avgScore         = job.portalReports && job.portalReports.filter((r) => r.score != null).length > 0
    ? Math.round(
        job.portalReports.filter((r) => r.score != null).reduce((s, r) => s + (r.score ?? 0), 0) /
        job.portalReports.filter((r) => r.score != null).length,
      )
    : null;
  const publishedResults = job.publishResults ?? [];
  // Heading priority: AI-generated title > customer topic (if not a raw content-type slug) >
  // template name > content type label > fallback.
  const CONTENT_TYPE_SLUGS = new Set(['clips', 'news', 'sports', 'short', 'custom', 'show_commentary']);
  const _aiTitle      = job.publishCopy?.youtube?.title || null;
  const _topicRaw     = job.wizardConfig?.topic || null;
  const _topicClean   = _topicRaw && !CONTENT_TYPE_SLUGS.has(_topicRaw.toLowerCase()) ? _topicRaw : null;
  const jobHeading    = _aiTitle
    || _topicClean
    || job.wizardConfig?.templateName
    || (job.wizardConfig?.contentType ? labelForContentType(job.wizardConfig.contentType) : null)
    || 'Video job';

  // Pre-compute terminal state config outside JSX to avoid IIFE
  type TerminalCfg = { border: string; from: string; dot: string; labelColor: string; label: string; desc: string };
  const terminalCfg: TerminalCfg | null = (!isActive && !isReadyForReview) ? (() => {
    const configs: Record<string, TerminalCfg> = {
      published: {
        border: 'border-violet-200 dark:border-violet-800',
        from:   'from-violet-50/50 dark:from-violet-950/20',
        dot:    'bg-violet-500',
        labelColor: 'text-violet-700 dark:text-violet-400',
        label: 'Published',
        desc:  'Your video has been published to your connected platforms.',
      },
      failed: {
        border: 'border-red-200 dark:border-red-800',
        from:   'from-red-50/50 dark:from-red-950/20',
        dot:    'bg-red-500',
        labelColor: 'text-red-700 dark:text-red-400',
        label: 'Failed',
        desc:  isSuperAdmin
          ? 'This job failed during production. Use operator actions below to retry or investigate.'
          : 'Something went wrong during production. Please contact support if this persists.',
      },
      held: {
        border: 'border-amber-200 dark:border-amber-800',
        from:   'from-amber-50/40 dark:from-amber-950/15',
        dot:    'bg-amber-400',
        labelColor: 'text-amber-600 dark:text-amber-400',
        label: 'On hold',
        desc:  'This job is paused and waiting for operator action.',
      },
    };
    return configs[job.status] ?? {
      border: 'border-border',
      from:   'from-muted/30',
      dot:    'bg-muted-foreground',
      labelColor: 'text-muted-foreground',
      label: job.status,
      desc:  '',
    };
  })() : null;

  const scoreBadge = avgScore != null ? (
    <span className={cn(
      'text-xs font-bold px-2 py-0.5 rounded-full',
      avgScore >= 80 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300' :
      avgScore >= 60 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' :
      'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    )}>
      {avgScore}/100
    </span>
  ) : null;

  return (
    <div className="space-y-4 max-w-2xl">

      {/* ── Active / Building hero ── */}
      {isActive && (
        <div className="rounded-xl border bg-gradient-to-b from-blue-50/50 to-background dark:from-blue-950/20 px-5 py-6 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
                <span className="text-xs font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                  {job.status === 'queued' ? 'Queued' : 'In production'}
                </span>
              </div>
              <h1 className="text-xl font-semibold">
                {job.status === 'queued' ? 'Getting ready…' : 'Building your video'}
              </h1>
              <SpecStrip job={job} />
            </div>
            <Link href="/myjobs/active" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}>
              ← All jobs
            </Link>
          </div>

          {job.status === 'queued' ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/40 animate-pulse shrink-0" />
              Your job is in the queue and will start shortly.
            </div>
          ) : (
            <FriendlyStepper portalReports={job.portalReports} />
          )}
        </div>
      )}

      {/* ── Ready for review hero ── */}
      {isReadyForReview && (
        <div className="rounded-xl border-2 border-emerald-200 dark:border-emerald-800 bg-gradient-to-b from-emerald-50/50 to-background dark:from-emerald-950/20 px-5 py-6 space-y-4">

          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                  {isStaged ? 'Review before publishing' : 'Ready'}
                </span>
                {scoreBadge}
              </div>
              <h1 className="text-xl font-semibold">{jobHeading}</h1>
              <SpecStrip job={job} />
            </div>
            <Link href="/myjobs/history" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}>
              ← History
            </Link>
          </div>

          {/* Video player */}
          <video
            src={job.outputUrl!}
            controls
            preload="metadata"
            poster={job.thumbnailUrl ?? undefined}
            className="w-full rounded-lg border bg-black aspect-video object-contain"
          />

          {/* Thumbnail picker (CPD-512) */}
          {thumbCandidates && thumbCandidates.length > 0 && !thumbApproved && (
            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Choose a thumbnail</p>
              <div className="grid grid-cols-3 gap-2">
                {thumbCandidates.map((c) => (
                  <button
                    key={c.index}
                    disabled={thumbApproving}
                    onClick={() => handleSelectThumbnail(c)}
                    className="relative rounded overflow-hidden border-2 border-transparent hover:border-primary focus:border-primary transition-colors focus:outline-none disabled:opacity-50"
                  >
                    <img src={c.url} alt={`Thumbnail ${c.index + 1}`} className="w-full aspect-video object-cover" />
                    {c.method === 'imagen' && (
                      <span className="absolute top-1 left-1 text-[8px] font-bold bg-purple-600/90 text-white rounded px-1 py-0.5 leading-none">
                        Imagen 3
                      </span>
                    )}
                    {c.score != null && (
                      <span className="absolute bottom-1 right-1 text-[9px] font-bold bg-black/70 text-white rounded px-1">
                        {c.score}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">Click to set as your video thumbnail before publishing.</p>
            </div>
          )}
          {thumbApproved && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2">
              <img src={thumbApproved} alt="Approved thumbnail" className="w-12 h-7 object-cover rounded shrink-0" />
              <p className="text-xs text-emerald-700 dark:text-emerald-300">✓ Thumbnail selected</p>
            </div>
          )}

          {/* ── Staging-only: full pre-publish review panel ── */}
          {isStaged && (
            <div className="space-y-4 border-t pt-4">

              {/* Quick-approve CTA — visible at top so customers don't need to scroll (CPD-544, CPD-546) */}
              <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/60 dark:bg-emerald-950/20 px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">Ready to publish?</p>
                  <p className="text-[10px] text-emerald-700/70 dark:text-emerald-400/70">
                    {reviewEdited ? 'Changes saved — publish when ready.' : 'Review & edit below, or publish as-is.'}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                  onClick={handleApprovePublish}
                  disabled={approving}
                >
                  {approving ? 'Publishing…' : '✓ Publish now'}
                </Button>
              </div>

              {/* Publishing to — connected account confirmation */}
              {job.platforms.length > 0 && (
                <div className="rounded-lg border bg-muted/30 px-3 py-2.5 space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Publishing to</p>
                  <div className="flex flex-wrap gap-2">
                    {job.platforms.map((p) => {
                      const acct = connectedAccounts.find((a) => a.platform === p);
                      return (
                        <span key={p} className="flex items-center gap-1.5 text-xs bg-background border rounded-full px-2.5 py-1">
                          <span>{PLATFORM_ICONS[p] ?? '📤'}</span>
                          <span className="font-medium">{platformLabel(p)}</span>
                          {acct?.handle && <span className="text-muted-foreground">· @{acct.handle}</span>}
                          {!acct && (
                            <>
                              <span className="text-amber-500 text-[10px]">· not connected</span>
                              <a href="/settings/social" className="text-[10px] text-primary underline hover:no-underline ml-0.5">Connect →</a>
                            </>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Editable publish metadata */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  ✨ Post details
                  <span className="ml-1.5 font-normal normal-case text-muted-foreground/70">(pre-filled — edit anything before publishing)</span>
                </p>

                <div className="space-y-2">
                  <div>
                    <label className="text-[11px] text-muted-foreground block mb-0.5">Title</label>
                    <input
                      type="text"
                      value={reviewTitle}
                      onChange={(e) => { setReviewTitle(e.target.value); setReviewEdited(true); }}
                      placeholder="Video title"
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground block mb-0.5">Description</label>
                    <textarea
                      value={reviewDesc}
                      onChange={(e) => { setReviewDesc(e.target.value); setReviewEdited(true); }}
                      placeholder="Video description"
                      rows={3}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground block mb-0.5">Tags</label>
                    <input
                      type="text"
                      value={reviewTags}
                      onChange={(e) => { setReviewTags(e.target.value); setReviewEdited(true); }}
                      placeholder="gaming, highlights, clip"
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <p className="text-[10px] text-muted-foreground mt-0.5">No # needed — e.g. gaming, twitch, highlights</p>
                  </div>
                  {job.platforms.includes('youtube') && (
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-muted-foreground shrink-0">Visibility</label>
                      <select
                        value={reviewPrivacy}
                        onChange={(e) => { setReviewPrivacy(e.target.value as typeof reviewPrivacy); setReviewEdited(true); }}
                        className="text-sm border rounded-md px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="public">Public</option>
                        <option value="unlisted">Unlisted</option>
                        <option value="private">Private</option>
                      </select>
                    </div>
                  )}

                  {/* TikTok caption */}
                  {job.platforms.includes('tiktok') && (
                    <div>
                      <label className="text-[11px] text-muted-foreground flex items-center gap-1 mb-0.5">
                        <span>🎵</span> TikTok caption <span className="text-[10px]">(max 280)</span>
                      </label>
                      <textarea
                        value={reviewTiktok}
                        onChange={(e) => { setReviewTiktok(e.target.value.slice(0, 280)); setReviewEdited(true); }}
                        placeholder="TikTok caption + hashtags"
                        rows={2}
                        maxLength={280}
                        className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                      <p className="text-[10px] text-muted-foreground text-right">{reviewTiktok.length}/280</p>
                    </div>
                  )}

                  {/* Instagram caption */}
                  {job.platforms.includes('instagram') && (
                    <div>
                      <label className="text-[11px] text-muted-foreground flex items-center gap-1 mb-0.5">
                        <span>📸</span> Instagram caption <span className="text-[10px]">(max 2200)</span>
                      </label>
                      <textarea
                        value={reviewInstagram}
                        onChange={(e) => { setReviewInstagram(e.target.value.slice(0, 2200)); setReviewEdited(true); }}
                        placeholder="Instagram caption + hashtags"
                        rows={3}
                        maxLength={2200}
                        className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                      <p className="text-[10px] text-muted-foreground text-right">{reviewInstagram.length}/2200</p>
                    </div>
                  )}
                </div>
              </div>

              {/* QA scores — shown before script so decision-relevant info is higher (CPD-547, CPD-557) */}
              {stagingAssets?.portalReports && stagingAssets.portalReports.length > 0 && (
                <div className="rounded-lg border bg-muted/20 p-3 space-y-1.5">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Production QA scores</p>
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">How closely your video matched the order. 90+ is excellent. Below 70 goes to operator review.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {stagingAssets.portalReports.filter((r) => r.score != null).map((r) => (
                      <div key={r.portal} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground truncate">{r.label ?? r.portal}</span>
                        <span className={cn('font-semibold tabular-nums ml-2 shrink-0',
                          (r.score ?? 0) >= 90 ? 'text-emerald-600' :
                          (r.score ?? 0) >= 70 ? 'text-amber-600' : 'text-destructive'
                        )}>
                          {r.score}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Script preview (collapsible) — below QA scores */}
              {stagingAssets?.output?.script && (
                <div className="rounded-lg border bg-muted/20 overflow-hidden">
                  <button
                    onClick={() => setScriptExpanded((v) => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/40 transition-colors"
                  >
                    <span>📄 Script preview</span>
                    <span>{scriptExpanded ? '▲' : '▼'}</span>
                  </button>
                  {scriptExpanded && (
                    <pre className="px-3 pb-3 text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/80 max-h-48 overflow-y-auto">
                      {stagingAssets.output.script}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-col sm:flex-row gap-2">
            {job.status === 'staged' ? (
              <Button
                size="sm"
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={handleApprovePublish}
                disabled={approving}
              >
                {approving
                  ? 'Publishing…'
                  : `✓ Approve & publish${job.platforms.length > 0 ? ` to ${job.platforms.map(platformLabel).join(', ')}` : ''}`}
              </Button>
            ) : (
              <a
                href={job.outputUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ size: 'sm' }), 'flex-1 text-center bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600')}
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
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              ✓ Published. Check your platforms for live links.
            </div>
          )}
        </div>
      )}

      {/* ── Terminal state heroes (operator_review / published / failed / held) ── */}
      {terminalCfg && (
        <div className={cn('rounded-xl border-2 bg-gradient-to-b to-background px-5 py-6 space-y-4', terminalCfg.border, terminalCfg.from)}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className={cn('inline-block w-2 h-2 rounded-full shrink-0', terminalCfg.dot)} />
                <span className={cn('text-xs font-semibold uppercase tracking-wide', terminalCfg.labelColor)}>
                  {terminalCfg.label}
                </span>
                {scoreBadge}
              </div>
              <h1 className="text-xl font-semibold">{jobHeading}</h1>
              <p className="text-sm text-muted-foreground mt-0.5">{terminalCfg.desc}</p>
              <SpecStrip job={job} />
            </div>
            <Link href="/myjobs" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}>
              ← Jobs
            </Link>
          </div>

          {/* Customer CTA for failed */}
          {job.status === 'failed' && !isSuperAdmin && (
            <a
              href="mailto:support@auraflux.co"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'border-red-200 text-red-700 dark:border-red-800 dark:text-red-400')}
            >
              Contact support →
            </a>
          )}
        </div>
      )}

      {/* ── Admin pipeline detail — collapsed by default ── */}
      {isSuperAdmin && hasPortals && (
        <details className="rounded-xl border overflow-hidden group">
          <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/20 transition-colors list-none">
            <div className="flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
              Pipeline detail (admin)
            </div>
            {scoreBadge}
          </summary>
          <div className="px-4 py-3 border-t border-border/50 space-y-1.5 bg-muted/5">
            {(job.portalReports ?? []).map((report, i) => (
              <div key={report.portal} className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2',
                report.status === 'pass'    ? 'bg-emerald-950/15 border border-emerald-900/20' :
                report.status === 'failed'  ? 'bg-red-950/15 border border-red-900/20' :
                report.status === 'hold'    ? 'bg-amber-950/15 border border-amber-900/20' :
                'bg-muted/10',
              )}>
                <div className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
                  report.status === 'pass'    ? 'bg-emerald-500 text-white' :
                  report.status === 'running' ? 'bg-blue-500 text-white animate-pulse' :
                  report.status === 'failed'  ? 'bg-red-500 text-white' :
                  report.status === 'hold'    ? 'bg-amber-500 text-white' :
                  report.status === 'skipped' ? 'bg-muted text-muted-foreground' :
                  'bg-muted/60 text-muted-foreground',
                )}>
                  {report.status === 'pass'    ? '✓' :
                   report.status === 'failed'  ? '✕' :
                   report.status === 'running' ? '…' :
                   report.status === 'skipped' ? '—' :
                   report.status === 'hold'    ? '!' :
                   String(i + 1)}
                </div>
                <span className="text-xs font-mono flex-1 text-muted-foreground">
                  {PORTAL_LABELS[report.portal] ?? report.portal}
                </span>
                {report.score != null && (
                  <span className={cn(
                    'text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full',
                    report.score >= 80 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' :
                    report.score >= 60 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' :
                    'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
                  )}>
                    {report.score}/100
                  </span>
                )}
                <Badge
                  variant={report.status === 'pass' ? 'default' : report.status === 'failed' ? 'destructive' : 'outline'}
                  className={cn('text-[10px] capitalize px-1.5', report.status === 'pass' ? 'bg-emerald-500 border-emerald-500' : '')}
                >
                  {report.status}
                </Badge>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* ── Output — thumbnail-first, non-review path ── */}
      {!isReadyForReview && job.outputUrl && (
        <div className="rounded-xl border overflow-hidden">
          {job.thumbnailUrl ? (
            <div className="relative">
              <img src={job.thumbnailUrl} alt="Video thumbnail" className="w-full max-h-64 object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
              <div className="absolute bottom-3 left-3 right-3 flex gap-2">
                <a
                  href={job.outputUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants({ size: 'sm' }), 'flex-1 text-center bg-white text-black hover:bg-white/90 border-0')}
                >
                  ▶ Watch video
                </a>
                <a
                  href={job.outputUrl}
                  download
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'bg-black/40 border-white/30 text-white hover:bg-black/60 hover:text-white')}
                >
                  ↓
                </a>
              </div>
            </div>
          ) : (
            <div className="px-4 py-4 flex gap-2">
              <a
                href={job.outputUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ size: 'sm' }), 'flex-1 text-center')}
              >
                ▶ Watch video
              </a>
              <a
                href={job.outputUrl}
                download
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'flex-1 text-center')}
              >
                ↓ Download
              </a>
            </div>
          )}
        </div>
      )}

      {/* ── Publish copy ── */}
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

      {/* ── Generated script ── */}
      {job.filledScript && job.wizardConfig?.activeFeatures?.includes('script') && (
        <ScriptCard script={job.filledScript} />
      )}

      {/* ── Published / failed publish results — horizontal platform grid ── */}
      {publishedResults.length > 0 && (
        <div className="rounded-xl border-2 border-violet-200 dark:border-violet-800 bg-gradient-to-b from-violet-50/30 to-background dark:from-violet-950/15 overflow-hidden">
          <div className="px-4 py-3 border-b border-violet-200/60 dark:border-violet-800/60 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-violet-500 shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-400">
              Publish results
            </span>
          </div>
          <div className={cn(
            'p-3 grid gap-2',
            publishedResults.length === 1 ? 'grid-cols-1' :
            publishedResults.length === 2 ? 'grid-cols-2' :
            'grid-cols-3',
          )}>
            {publishedResults.map((r) => (
              <div
                key={r.platform}
                className={cn(
                  'flex flex-col gap-2.5 rounded-lg border px-3 py-3',
                  r.status === 'published'
                    ? 'bg-violet-50/60 dark:bg-violet-950/25 border-violet-100 dark:border-violet-900/40'
                    : 'bg-red-50/60 dark:bg-red-950/25 border-red-200 dark:border-red-900/40',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl leading-none">{PLATFORM_ICONS[r.platform] ?? '•'}</span>
                  <div>
                    <p className="text-sm font-semibold">{platformLabel(r.platform)}</p>
                    {r.publishedAt && (
                      <p className="text-[10px] text-muted-foreground">{new Date(r.publishedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                    )}
                    {r.status !== 'published' && (
                      <p className="text-[10px] text-red-600 dark:text-red-400 font-medium mt-0.5">Publish failed</p>
                    )}
                  </div>
                </div>
                {r.status !== 'published' && r.error && (
                  <p className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 rounded px-2 py-1.5">{r.error}</p>
                )}
                {r.status !== 'published' && !r.error && (
                  <p className="text-[11px] text-muted-foreground">Contact support if this persists.</p>
                )}
                {r.driveUrl && (
                  <a
                    href={r.driveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ size: 'sm' }), 'w-full text-center bg-violet-600 hover:bg-violet-700 text-white border-0 text-xs')}
                  >
                    View live →
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Operator actions ── */}
      {isSuperAdmin && (
        <div className="rounded-xl bg-zinc-950 dark:bg-zinc-900/80 border border-zinc-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wide text-orange-400">Operator actions</span>
          </div>
          <div className="px-4 py-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm" variant="outline"
                disabled={isPending || !['failed', 'held', 'complete'].includes(job.status)}
                onClick={() => handleOperatorAction('retry')}
                className="border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800 disabled:opacity-40"
              >
                Retry (full re-run)
              </Button>
              <Button
                size="sm" variant="outline"
                disabled={isPending || !['failed', 'held', 'running'].includes(job.status)}
                onClick={() => handleOperatorAction('advance')}
                className="border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800 disabled:opacity-40"
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
              <p className="text-xs text-red-400">{formatUserError(actionError)}</p>
            )}
            <p className="text-[10px] text-zinc-500">
              Retry: re-runs full pipeline · Force advance: skips blocked portal · Rollback: resets to held state
            </p>
          </div>
        </div>
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
