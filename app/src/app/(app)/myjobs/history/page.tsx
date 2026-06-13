'use client';
/**
 * /myjobs/history — Review queue + completed jobs (CPD-112)
 *
 * Tab 1 — "Review queue":  staged jobs awaiting customer approval
 * Tab 2 — "Completed":     complete + published jobs
 *
 * Deep-link: ?tab=review   opens directly to the review tab
 */

import { useEffect, useState, Suspense } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { listJobs, type Job, type WizardConfig, type PublishResult } from '@/lib/api';
import { labelForContentType } from '@/lib/content-types';
import { jobDisplayTitle, jobStatusLabel, platformLabel, formatUserError } from '@/lib/job-labels';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { useBrand } from '@/contexts/brand-context';

const COMPLETE_STATUSES = new Set(['complete', 'published']);

const PLATFORM_ICONS: Record<string, string> = {
  youtube:   '▶',
  tiktok:    '♪',
  instagram: '◎',
};

// Brand-accurate platform colors
const PLATFORM_BADGE_CLASSES: Record<string, string> = {
  youtube:   'bg-red-950/60 text-red-400 border border-red-800/50',
  tiktok:    'bg-cyan-950/60 text-cyan-300 border border-cyan-800/50',
  instagram: 'bg-purple-950/60 text-purple-400 border border-purple-800/50',
  twitter:   'bg-sky-950/60 text-sky-400 border border-sky-800/50',
  facebook:  'bg-blue-950/60 text-blue-400 border border-blue-800/50',
  linkedin:  'bg-blue-950/60 text-blue-300 border border-blue-800/50',
};

// Left-border accent color for cards based on primary platform
const PLATFORM_BORDER: Record<string, string> = {
  youtube:   'border-l-red-500',
  tiktok:    'border-l-cyan-400',
  instagram: 'border-l-purple-500',
  twitter:   'border-l-sky-400',
  facebook:  'border-l-blue-500',
  linkedin:  'border-l-blue-400',
};

function cardAccent(platforms: string[]): string {
  const primary = platforms[0];
  return primary ? (PLATFORM_BORDER[primary] ?? 'border-l-indigo-500') : 'border-l-indigo-500';
}

const ADDON_LABELS: Record<string, string> = {
  tts:            'Voiceover',
  heygen:         'Avatar',
  shoppable:      'Shoppable tagging',
  wan:            'Video generation',
  clipSourcing:   'Scene selection',
  showCommentary: 'Narrative narration',
  branding:       'Brand overlay',
  imageBurn:      'Image burn',
  dynamicOverlays:'Dynamic overlays',
  captions:       'Captions',
  colorGrade:     'Color grade',
  effects:        'Visual effects',
};

function fmtJobTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = {
    month:  'short',
    day:    'numeric',
    hour:   'numeric',
    minute: '2-digit',
  };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleString('en-US', opts);
}

function formFactorLabel(wc: WizardConfig) {
  const ff = wc.formFactor || (wc.templateId === 'short-form' ? 'short' : 'long');
  return ff === 'short' ? 'Short-form (9:16)' : 'Long-form (16:9)';
}

function entryTypeLabel(et: string | null) {
  if (et === 'fetch')  return 'URL fetch';
  if (et === 'upload') return 'File upload';
  if (et === 'create') return 'Generated';
  return et ?? '—';
}

function SelectionReview({ wc }: { wc: WizardConfig }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        <span>{open ? '▾' : '▸'}</span> What you selected
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-border bg-muted/20 p-3 text-xs space-y-2">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {wc.templateName && (
              <>
                <span className="text-muted-foreground">Template</span>
                <span className="font-medium">{wc.templateName}</span>
              </>
            )}
            <span className="text-muted-foreground">Format</span>
            <span>{formFactorLabel(wc)}</span>
            <span className="text-muted-foreground">Source</span>
            <span>{entryTypeLabel(wc.entryType)}</span>
            {wc.contentType && (
              <>
                <span className="text-muted-foreground">Content type</span>
                <span>{labelForContentType(wc.contentType)}</span>
              </>
            )}
            {wc.publishMode && (
              <>
                <span className="text-muted-foreground">Publish</span>
                <span className="capitalize">{wc.publishMode}{wc.scheduledAt ? ` — ${new Date(wc.scheduledAt).toLocaleDateString()}` : ''}</span>
              </>
            )}
          </div>
          {wc.addOns.length > 0 && (
            <div>
              <p className="text-muted-foreground mb-1">Features applied</p>
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
              <p className="text-muted-foreground mb-1">Platforms</p>
              <div className="flex gap-1">
                {wc.platforms.map((p) => (
                  <Badge key={p} variant="secondary" className={cn('text-[10px] px-1.5', PLATFORM_BADGE_CLASSES[p])}>
                    {PLATFORM_ICONS[p] ?? '•'} {platformLabel(p)}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground pt-1 border-t border-border">
            Save this as a template to pre-fill your next job with these settings. Open the job to save it.
          </p>
        </div>
      )}
    </div>
  );
}

function PublishLinks({ results }: { results: PublishResult[] }) {
  const published = results.filter((r) => r.status === 'published' && (r.platformJobId || r.driveUrl));
  if (published.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {published.map((r) => (
        <a
          key={r.platform}
          href={r.driveUrl ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-xs h-7 px-2 gap-1')}
        >
          {PLATFORM_ICONS[r.platform] ?? '•'} View on {r.platform}
        </a>
      ))}
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<div className="max-w-3xl space-y-6"><div className="h-8 w-48 bg-muted/40 rounded animate-pulse" /></div>}>
      <HistoryPageContent />
    </Suspense>
  );
}

function HistoryPageContent() {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand }        = useBrand();
  const activeBrandId          = activeBrand?.id;
  const searchParams           = useSearchParams();
  const [jobs, setJobs]        = useState<Job[] | null>(null);
  const [error, setError]      = useState<string | null>(null);

  // Legacy deep-link — review lives at /review (brand-scoped for sub-brands).
  useEffect(() => {
    if (searchParams.get('tab') === 'review' && typeof window !== 'undefined') {
      window.location.replace('/review');
    }
  }, [searchParams]);

  useEffect(() => {
    if (!isLoaded) return;
    async function load() {
      try {
        const token = await getToken();
        const res = await listJobs(token ?? undefined);
        setJobs((res.jobs ?? []).filter((j) => COMPLETE_STATUSES.has(j.status)));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load jobs');
      }
    }
    load();
  }, [getToken, isLoaded, activeBrandId]);

  const completedJobs = jobs?.filter((j) => COMPLETE_STATUSES.has(j.status)) ?? [];

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="History"
        subtitle="Your completed and published jobs"
      >
        <Link href="/myjobs/new" className={cn(buttonVariants({ size: 'sm' }))}>
          + New job
        </Link>
      </PageHeader>

      {error && (
        <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
      )}

      {/* Loading skeleton */}
      {jobs === null && !error && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      )}

      {jobs !== null && (
        completedJobs.length === 0 ? (
          <EmptyState
            title="No completed jobs yet"
            description="Once a job is published it will appear here with platform links and download options."
            action={{ label: 'Create your first job', href: '/myjobs/new' }}
          />
        ) : (
          <div className="space-y-3">
            {completedJobs.map((job) => (
              <HistoryCard key={job.jobId} job={job} />
            ))}
          </div>
        )
      )}
    </PageShell>
  );
}

function ReviewCard({ job }: { job: Job }) {
  const videoTitle = job.publishCopy?.youtube?.title as string | undefined;
  const displayTitle = videoTitle || jobDisplayTitle(job);
  return (
    <div className={cn('rounded-xl border border-emerald-800/50 bg-emerald-950/10 overflow-hidden border-l-4', cardAccent(job.platforms))}>
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <Link
                href={`/myjobs/${job.jobId}`}
                className="text-sm font-semibold text-foreground hover:text-primary transition-colors"
              >
                {displayTitle}
              </Link>
              <span className="text-[10px] font-medium bg-emerald-900/60 text-emerald-400 border border-emerald-800/60 px-1.5 py-0.5 rounded">
                Ready to review
              </span>
              {job.platforms.map((p) => (
                <span key={p} className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', PLATFORM_BADGE_CLASSES[p] ?? 'bg-muted/60 text-muted-foreground border border-border/60')}>
                  {PLATFORM_ICONS[p] ?? '•'} {platformLabel(p)}
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {fmtJobTime(job.createdAt)}
            </p>
          </div>
          <Link
            href={`/myjobs/${job.jobId}`}
            className={cn(buttonVariants({ size: 'sm' }), 'bg-emerald-700 hover:bg-emerald-600 text-white shrink-0 text-xs border-emerald-700')}
          >
            Review →
          </Link>
        </div>
      </div>
      {job.outputUrl && (
        <div className="px-4 pb-3 border-t border-emerald-800/30 pt-2.5">
          <a
            href={job.outputUrl}
            download
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-xs h-7 px-2')}
          >
            ↓ Download video
          </a>
        </div>
      )}
    </div>
  );
}

function HistoryCard({ job }: { job: Job }) {
  const isPublished = job.status === 'published';
  const videoTitle = job.publishCopy?.youtube?.title as string | undefined;
  const displayTitle = videoTitle || jobDisplayTitle(job);
  return (
    <div className={cn(
      'rounded-xl border bg-card overflow-hidden border-l-4',
      isPublished ? 'border-violet-800/40' : 'border-border',
      cardAccent(job.platforms),
    )}>
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/myjobs/${job.jobId}`}
                className="text-sm font-semibold text-foreground hover:text-primary transition-colors"
              >
                {displayTitle}
              </Link>
              <span className={cn(
                'text-[10px] font-medium px-1.5 py-0.5 rounded border',
                isPublished
                  ? 'bg-violet-900/60 text-violet-400 border-violet-800/60'
                  : 'bg-muted/60 text-muted-foreground border-border/60',
              )}>
                {jobStatusLabel(job.status)}
              </span>
              {job.platforms.map((p) => (
                <span key={p} className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', PLATFORM_BADGE_CLASSES[p] ?? 'bg-muted/60 text-muted-foreground border border-border/60')}>
                  {PLATFORM_ICONS[p] ?? '•'} {platformLabel(p)}
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {fmtJobTime(job.createdAt)}
            </p>
          </div>
          <Link
            href={`/myjobs/${job.jobId}`}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-xs h-7 px-2.5 shrink-0')}
          >
            Details →
          </Link>
        </div>
      </div>

      {((job.publishResults ?? []).filter((r) => r.status === 'published').length > 0 || job.outputUrl || job.wizardConfig) && (
        <div className="px-4 pb-3 border-t border-border/50 pt-2.5 space-y-2">
          {job.publishResults && job.publishResults.length > 0 && (
            <PublishLinks results={job.publishResults} />
          )}
          {job.outputUrl && (
            <a
              href={job.outputUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-xs h-7 px-2')}
            >
              ↓ Download video
            </a>
          )}
          {job.wizardConfig ? (
            <SelectionReview wc={job.wizardConfig} />
          ) : (
            <p className="text-xs text-muted-foreground/60">Selection review not available.</p>
          )}
        </div>
      )}
    </div>
  );
}
