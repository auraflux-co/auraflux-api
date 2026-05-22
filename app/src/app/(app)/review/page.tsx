'use client';
/**
 * /review — Output review staging area
 *
 * Lists all jobs that have completed output assets (video/thumbnail).
 * For each job shows a side-by-side input spec vs output comparison:
 *   - What was ordered (contentType, topic, tone, platforms, wizard config)
 *   - What was produced (video player, thumbnail, script, publish copy)
 *   - Portal pipeline timeline (each stage pass/fail)
 *   - Approve → Publish button (triggers upload-post via /v1/jobs/:id/approve-publish)
 *
 * Usage by Gemini QA agent:
 *   1. Submit jobs with "staging": true via POST /v1/jobs
 *   2. Poll GET /v1/jobs/:id until status = "complete" or "staged"
 *   3. Open this page to review inputs vs outputs visually
 *   4. Use "Approve & Publish" to push to clipzworldnews social accounts via upload-post
 *
 * Rob can delete test content from social platforms after review.
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { apiFetch } from '@/lib/api';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { EmptyState } from '@/components/ui/empty-state';

// ── Types ────────────────────────────────────────────────────────────────────

interface PortalReport {
  portal: string;
  passed: boolean;
  status: string;
  outcome: string | null;
  completedAt: string | null;
  violations: string[];
  notes: string | null;
}

interface StagingAssets {
  jobId: string;
  status: string;
  staging: boolean;
  input: {
    contentType: string | null;
    sourceType: string | null;
    tone: string | null;
    topic: string | null;
    duration: string | null;
    platforms: string[];
    planTier: string | null;
    wizardConfig: Record<string, unknown> | null;
    submittedAt: string;
  };
  output: {
    videoUrl: string | null;
    thumbnailUrl: string | null;
    script: string | null;
    publishCopy: Record<string, Record<string, unknown>> | null;
    savedOutputs: Record<string, unknown> | null;
  };
  portalReports: PortalReport[];
  urlExpiresAt: string;
}

interface JobRow {
  jobId: string;
  status: string;
  contentType: string | null;
  platforms: string[];
  outputUrl: string | null;
  createdAt: string | number;
}

// ── Portal labels ─────────────────────────────────────────────────────────────

const PORTAL_LABELS: Record<string, string> = {
  portal0:  'Source validation',
  portal1:  'Script generation',
  portal1b: 'Script review',
  portal2:  'Video assembly',
  portal3a: 'Assembly review',
  portal3b: 'Quality check',
  portal4:  'Broadcast QA',
  portal5:  'Delivery',
};

const PLATFORM_ICONS: Record<string, string> = {
  youtube:   '▶',
  tiktok:    '♪',
  instagram: '◎',
};

const PLATFORM_DISPLAY: Record<string, string> = {
  youtube:   'YouTube',
  tiktok:    'TikTok',
  instagram: 'Instagram',
};

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    complete:  'bg-green-100 text-green-800',
    staged:    'bg-blue-100 text-blue-800',
    running:   'bg-yellow-100 text-yellow-800',
    queued:    'bg-gray-100 text-gray-700',
    failed:    'bg-red-100 text-red-800',
    published: 'bg-purple-100 text-purple-800',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${variants[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

// ── Portal timeline ───────────────────────────────────────────────────────────

function PortalTimeline({ reports }: { reports: PortalReport[] }) {
  if (!reports.length) return <p className="text-xs text-muted-foreground">No portal data yet.</p>;

  return (
    <div className="flex flex-col gap-1">
      {reports.map((r) => (
        <div key={r.portal} className="flex items-start gap-2 text-xs">
          <span className={`mt-0.5 h-2 w-2 rounded-full shrink-0 ${r.passed ? 'bg-green-500' : r.status === 'pending' ? 'bg-gray-300' : 'bg-red-500'}`} />
          <div className="flex-1 min-w-0">
            <span className="font-medium">{PORTAL_LABELS[r.portal] ?? r.portal}</span>
            {r.status !== 'passed' && r.status !== 'pending' && (
              <span className="ml-1 text-muted-foreground">— {r.status}</span>
            )}
            {r.violations.length > 0 && (
              <ul className="mt-0.5 ml-2 list-disc text-red-600">
                {r.violations.map((v, i) => <li key={i}>{v}</li>)}
              </ul>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Publish copy section ──────────────────────────────────────────────────────

function PublishCopySection({ copy }: { copy: Record<string, Record<string, unknown>> }) {
  return (
    <div className="space-y-3">
      {Object.entries(copy).map(([platform, meta]) => (
        <div key={platform} className="rounded-md border p-3">
          <p className="af-subhead mb-1">
            {PLATFORM_ICONS[platform] ?? '●'} {platform}
          </p>
          {meta.title    != null && <p className="text-sm font-medium">{String(meta.title)}</p>}
          {meta.description != null && (
            <p className="mt-1 af-label whitespace-pre-wrap line-clamp-4">
              {String(meta.description)}
            </p>
          )}
          {Array.isArray(meta.tags) && meta.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {(meta.tags as string[]).map((t) => (
                <Badge key={t} variant="outline" className="text-xs">#{t}</Badge>
              ))}
            </div>
          )}
          {meta.caption != null && <p className="mt-1 text-xs italic text-muted-foreground">{String(meta.caption)}</p>}
        </div>
      ))}
    </div>
  );
}

// ── Staging review panel ──────────────────────────────────────────────────────

function StagingPanel({ jobId, token }: { jobId: string; token: string }) {
  const [assets, setAssets]     = useState<StagingAssets | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ error?: string | null } | null>(null);
  const [showScript, setShowScript] = useState(false);
  const [redoing, setRedoing]   = useState(false);
  const [redoResult, setRedoResult] = useState<{ ok?: boolean; error?: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<StagingAssets & { ok?: boolean }>(
          `/jobs/${jobId}/staging-assets`,
          { token }
        );
        setAssets(data);
      } catch (e: unknown) {
        setError('Failed to load review assets. Please refresh and try again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [jobId, token]);

  const handleApprovePublish = useCallback(async () => {
    if (!assets) return;
    setPublishing(true);
    try {
      const result = await apiFetch<Record<string, unknown>>(
        `/jobs/${jobId}/approve-publish`,
        {
          method: 'POST',
          body: JSON.stringify({ platforms: assets.input.platforms }),
          token,
        }
      );
      setPublishResult(result);
    } catch {
      setPublishResult({ error: 'Publish failed. Please try again.' });
    } finally {
      setPublishing(false);
    }
  }, [assets, jobId, token]);

  const handleRequestRedo = useCallback(async () => {
    setRedoing(true);
    try {
      await apiFetch(`/jobs/${jobId}/retry`, { method: 'POST', token });
      setRedoResult({ ok: true });
    } catch {
      setRedoResult({ error: 'Redo request failed. Please try again.' });
    } finally {
      setRedoing(false);
    }
  }, [jobId, token]);

  if (loading) return <p className="text-xs text-muted-foreground py-4 text-center">Loading review assets…</p>;
  if (error)   return <p className="text-xs text-red-600 py-4">{error}</p>;
  if (!assets) return null;

  const { input, output, portalReports } = assets;
  const hasOutput = !!(output.videoUrl || output.thumbnailUrl);
  const canPublish = hasOutput && assets.status !== 'published';

  return (
    <div className="space-y-4">
      {/* Input vs Output header */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* LEFT: What was ordered */}
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <p className="af-subhead">What was ordered</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Content type</dt>
            <dd>{input.contentType ?? '—'}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd>{input.sourceType ?? '—'}</dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{input.duration ?? '—'}</dd>
            <dt className="text-muted-foreground">Platforms</dt>
            <dd>{input.platforms.length ? input.platforms.map((p) => PLATFORM_DISPLAY[p] ?? p).join(', ') : '—'}</dd>
            <dt className="text-muted-foreground">Submitted</dt>
            <dd>{input.submittedAt ? new Date(input.submittedAt).toLocaleString() : '—'}</dd>
          </dl>
          {input.wizardConfig && (() => {
            const wc = input.wizardConfig as Record<string, unknown>;
            const addOns = Array.isArray(wc.addOns) ? (wc.addOns as string[]) : [];
            const activeFeatures = Array.isArray(wc.activeFeatures) ? (wc.activeFeatures as string[]) : [];
            const platforms = Array.isArray(wc.platforms) ? (wc.platforms as string[]) : [];
            const allFeatures = [...addOns, ...activeFeatures].filter(Boolean);
            return (
              <div className="mt-2 rounded-md border bg-background/60 p-3 space-y-1.5 text-xs">
                <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground/70">Spec detail</p>
                {!!wc.entryType    && <p><span className="text-muted-foreground">Source type:</span> {String(wc.entryType)}</p>}
                {wc.durationMins != null && <p><span className="text-muted-foreground">Duration:</span> {String(wc.durationMins)} min</p>}
                {wc.creditCost != null && <p><span className="text-muted-foreground">Credit cost:</span> {String(wc.creditCost)}</p>}
                {!!wc.publishMode  && <p><span className="text-muted-foreground">Publish:</span> <span className="capitalize">{String(wc.publishMode)}{wc.scheduledAt ? ` — ${new Date(String(wc.scheduledAt)).toLocaleDateString()}` : ''}</span></p>}
                {allFeatures.length > 0 && (
                  <p><span className="text-muted-foreground">Features:</span> {allFeatures.join(', ')}</p>
                )}
                {platforms.length > 0 && (
                  <p><span className="text-muted-foreground">Platforms:</span> {platforms.join(', ')}</p>
                )}
              </div>
            );
          })()}
        </div>

        {/* RIGHT: What was produced */}
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <p className="af-subhead">What was produced</p>
          {output.videoUrl ? (
            <video
              src={output.videoUrl}
              controls
              className="w-full rounded-md border max-h-48 bg-black"
              preload="metadata"
            />
          ) : (
            <div className="flex h-24 items-center justify-center rounded-md border bg-muted text-xs text-muted-foreground">
              No video output yet
            </div>
          )}
          {output.thumbnailUrl && (
            <img src={output.thumbnailUrl} alt="Thumbnail" className="w-full rounded-md border max-h-24 object-cover" />
          )}
          {assets.urlExpiresAt && (
            <p className="text-[10px] text-muted-foreground">
              Signed URLs expire at {new Date(assets.urlExpiresAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>

      {/* Script */}
      {output.script && (
        <div>
          <button
            className="text-xs font-medium text-blue-600 hover:underline"
            onClick={() => setShowScript((v) => !v)}
          >
            {showScript ? 'Hide script ▲' : 'Show generated script ▼'}
          </button>
          {showScript && (
            <pre className="mt-2 rounded-md border bg-muted/50 p-3 text-[11px] whitespace-pre-wrap max-h-64 overflow-y-auto">
              {output.script}
            </pre>
          )}
        </div>
      )}

      {/* Publish copy */}
      {output.publishCopy && Object.keys(output.publishCopy).length > 0 && (
        <div>
          <p className="text-xs font-semibold mb-2">Publish copy</p>
          <PublishCopySection copy={output.publishCopy as Record<string, Record<string, unknown>>} />
        </div>
      )}

      {/* Production steps */}
      <div>
        <p className="text-xs font-semibold mb-2">Production steps</p>
        <PortalTimeline reports={portalReports} />
      </div>

      <Separator />

      {/* Actions — Approve, Download, Redo */}
      <div className="space-y-3">
        {/* Publish result */}
        {publishResult && (
          <div className="rounded-md border p-3 text-xs">
            <p className="font-medium mb-1">
              {publishResult.error ? 'Publish failed' : 'Published successfully'}
            </p>
            {publishResult.error && <p className="text-red-600">{String(publishResult.error)}</p>}
            {!publishResult.error && <p className="text-green-600">Your video has been sent to the selected platforms.</p>}
          </div>
        )}

        {/* Redo result */}
        {redoResult && (
          <div className="rounded-md border p-3 text-xs">
            {redoResult.error
              ? <p className="text-red-600">{redoResult.error}</p>
              : <p className="text-blue-600">Redo requested — job re-queued for processing.</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {/* Approve & Publish */}
          {!publishResult && (
            <Button
              size="sm"
              disabled={!canPublish || publishing}
              onClick={handleApprovePublish}
            >
              {publishing ? 'Publishing…' : 'Approve & Publish'}
            </Button>
          )}

          {/* Download */}
          {output.videoUrl && (
            <a
              href={output.videoUrl}
              target="_blank"
              rel="noreferrer"
              download
              className="inline-flex items-center gap-1.5 text-xs font-medium border border-border rounded-md px-3 py-1.5 hover:bg-accent transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              Download
            </a>
          )}

          {/* Request Redo */}
          {!redoResult && assets.status !== 'published' && (
            <Button
              size="sm"
              variant="outline"
              disabled={redoing}
              onClick={handleRequestRedo}
            >
              {redoing ? 'Requesting…' : 'Request redo'}
            </Button>
          )}

          {/* Status messages */}
          {!hasOutput && (
            <p className="text-xs text-muted-foreground">No output yet — wait for pipeline to complete.</p>
          )}
          {assets.status === 'published' && !publishResult && (
            <p className="text-xs text-green-600">Already published.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function StagingPage() {
  const { getToken } = useAuth();
  const [jobs, setJobs]         = useState<JobRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [token, setToken]       = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const t = await getToken();
        setToken(t);
        const data = await apiFetch<{ jobs: JobRow[] }>('/jobs', { token: t ?? undefined });
        // Review queue = work to do only. Published jobs live in Jobs → History.
        const withOutput = (data.jobs ?? []).filter(
          (j) => ['complete', 'staged'].includes(j.status)
        );
        setJobs(withOutput);
      } catch {
        setError('Failed to load jobs. Refresh to try again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken]);

  function formatDate(ts: string | number) {
    const n = typeof ts === 'string' ? Number(ts) : ts;
    const d = n > 1e12 ? new Date(n) : new Date(ts);
    return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
  }

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="Review Queue"
        subtitle="Videos ready for your review before publishing to social platforms."
      />

      {loading && <p className="af-body text-muted-foreground">Loading jobs…</p>}
      {error   && <p className="af-body text-destructive">{error}</p>}

      {!loading && !error && jobs.length === 0 && (
        <EmptyState
          title="Queue is clear"
          description="Once a job finishes processing, it will appear here for review before publishing."
          size="md"
        />
      )}

      {jobs.map((job) => {
        const isOpen = expanded === job.jobId;
        return (
          <Card key={job.jobId} className={isOpen ? 'ring-2 ring-blue-500/30' : ''}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-sm font-mono">{job.jobId}</CardTitle>
                    <StatusBadge status={job.status} />
                    {job.outputUrl && (
                      <Badge variant="outline" className="text-xs">has output</Badge>
                    )}
                  </div>
                  <p className="af-caption mt-1">
                    {job.contentType ?? 'unknown'}{' · '}
                    {job.platforms?.length ? job.platforms.map((p) => PLATFORM_ICONS[p] ?? p).join(' ') : 'no platforms'}{' · '}
                    {formatDate(job.createdAt)}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Link
                    href={`/myjobs/${job.jobId}`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    Detail
                  </Link>
                  <button
                    className="text-xs font-medium text-blue-600 hover:underline"
                    onClick={() => setExpanded(isOpen ? null : job.jobId)}
                  >
                    {isOpen ? 'Collapse ▲' : 'Review ▼'}
                  </button>
                </div>
              </div>
            </CardHeader>

            {isOpen && token && (
              <CardContent className="pt-0">
                <Separator className="mb-4" />
                <StagingPanel jobId={job.jobId} token={token} />
              </CardContent>
            )}
          </Card>
        );
      })}
    </PageShell>
  );
}
