'use client';
/**
 * /myjobs/history — Completed jobs (CPD-112)
 *
 * Shows complete/published jobs with:
 *  - Post-publish links (YouTube, TikTok, Instagram platform URLs)
 *  - "What you selected" selection review card — foundation for saved templates
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { listJobs, type Job, type WizardConfig, type PublishResult } from '@/lib/api';
import { labelForContentType } from '@/lib/content-types';
import { jobDisplayTitle, jobStatusLabel, platformLabel, formatUserError } from '@/lib/job-labels';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { EmptyState } from '@/components/ui/empty-state';

const COMPLETE_STATUSES = new Set(['complete', 'published']);

const PLATFORM_ICONS: Record<string, string> = {
  youtube:   '▶',
  tiktok:    '♪',
  instagram: '◎',
};

const ADDON_LABELS: Record<string, string> = {
  tts:            'ElevenLabs TTS',
  heygen:         'HeyGen avatar',
  shoppable:      'Shoppable tagging',
  wan:            'Video generation',
  clipSourcing:   'Scene selection',
  showCommentary: 'Narrative narration',
  branding:       'Brand overlay',
  imageBurn:      'Image burn',
  dynamicOverlays:'Dynamic overlays',
};

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
                  <Badge key={p} variant="secondary" className="text-[10px] capitalize px-1.5">
                    {PLATFORM_ICONS[p] ?? '•'} {p}
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
  const { getToken, isLoaded } = useAuth();
  const [jobs, setJobs]        = useState<Job[] | null>(null);
  const [error, setError]      = useState<string | null>(null);

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
  }, [getToken, isLoaded]);

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="My job history"
        subtitle="Completed jobs, post-publish links, and selection review"
      >
        <Link href="/myjobs/new" className={cn(buttonVariants({ size: 'sm' }))}>
          + New job
        </Link>
      </PageHeader>

      {error && (
        <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
      )}

      {jobs === null && !error && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      )}

      {jobs !== null && jobs.length === 0 && !error && (
        <EmptyState
          title="No completed jobs yet"
          description="Once a job finishes, it will appear here with download links and publish history."
          action={{ label: 'Create your first job', href: '/myjobs/new' }}
        />
      )}

      {jobs !== null && jobs.length > 0 && (
        <div className="space-y-3">
          {jobs.map((job) => (
            <HistoryCard key={job.jobId} job={job} />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function HistoryCard({ job }: { job: Job }) {
  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/myjobs/${job.jobId}`}
                className="text-sm font-medium hover:underline"
              >
                {jobDisplayTitle(job)}
              </Link>
              <Badge variant="default" className="text-[10px]">{jobStatusLabel(job.status)}</Badge>
              {job.platforms.map((p) => (
                <Badge key={p} variant="outline" className="text-[10px]">
                  {PLATFORM_ICONS[p] ?? '•'} {platformLabel(p)}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {labelForContentType(job.contentType)} · {new Date(job.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
          <Link
            href={`/myjobs/${job.jobId}`}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-xs h-7 px-2 shrink-0')}
          >
            Details →
          </Link>
        </div>
      </CardHeader>

      <CardContent className="pb-4 px-4 space-y-3">
        {/* Post-publish links */}
        {job.publishResults && job.publishResults.length > 0 && (
          <PublishLinks results={job.publishResults} />
        )}

        {/* Output video link */}
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

        {/* Publish copy preview */}
        {job.publishCopy?.youtube?.title && (
          <div className="text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1.5 line-clamp-1">
            "{job.publishCopy.youtube.title}"
          </div>
        )}

        <Separator className="my-1" />

        {/* Selection review */}
        {job.wizardConfig ? (
          <SelectionReview wc={job.wizardConfig} />
        ) : (
          <p className="text-xs text-muted-foreground">Selection review not available for this job.</p>
        )}
      </CardContent>
    </Card>
  );
}
