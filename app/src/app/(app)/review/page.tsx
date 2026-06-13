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
 *   2. Poll GET /v1/jobs/:id until status = "complete", "staged", or "operator_review"
 *   3. Open this page to review inputs vs outputs visually
 *   4. Use "Approve & Publish" to push to AuraFlux social accounts via upload-post
 *
 * Rob can delete test content from social platforms after review.
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { updateJobSchedule, getSchedulePrefs, type SchedulePrefs, type ScheduleSlot } from '@/lib/api';
import { Separator } from '@/components/ui/separator';
import { apiFetch, listJobs, type Job } from '@/lib/api';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { jobDisplayTitle, jobStatusLabel, portalStatusLabel, platformLabel, entryTypeLabel, formatUserError, isReviewQueueJob } from '@/lib/job-labels';
import { labelForContentType } from '@/lib/content-types';
import { useBrand } from '@/contexts/brand-context';

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

// ── Publish best practices ────────────────────────────────────────────────────

const BEST_PRACTICES: Record<string, {
  icon: string;
  color: string;
  bestDays: string;
  bestTimes: string;
  frequency: string;
  tip: string;
}> = {
  youtube: {
    icon: '▶',
    color: 'border-red-800/50 bg-red-950/20',
    bestDays: 'Thu – Sun',
    bestTimes: '2 – 4 PM  ·  7 – 9 PM',
    frequency: '2 – 3× per week',
    tip: 'Upload by Thursday — the algorithm surfaces new content over the weekend when watch time peaks.',
  },
  tiktok: {
    icon: '♪',
    color: 'border-cyan-800/50 bg-cyan-950/20',
    bestDays: 'Tue – Thu',
    bestTimes: '7 – 9 AM  ·  7 – 11 PM',
    frequency: 'Daily or 5 – 7× per week',
    tip: 'TikTok rewards consistency over perfection. Daily posting is the single biggest growth lever.',
  },
  instagram: {
    icon: '◎',
    color: 'border-purple-800/50 bg-purple-950/20',
    bestDays: 'Tue – Fri',
    bestTimes: '11 AM – 1 PM  ·  7 – 9 PM',
    frequency: '3 – 5× per week',
    tip: 'Reels get 2× the reach of static posts. Prioritise scheduling Reels during lunch and evening slots.',
  },
};

function PublishBestPractices({ platforms }: { platforms: string[] }) {
  const relevant = platforms.filter((p) => BEST_PRACTICES[p]);
  if (relevant.length === 0) return null;
  return (
    <div className="rounded-xl border border-border/50 bg-muted/10 p-4 space-y-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Best times to publish
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {relevant.map((p) => {
          const bp = BEST_PRACTICES[p];
          return (
            <div key={p} className={`rounded-lg border p-3 space-y-1.5 ${bp.color}`}>
              <p className="text-xs font-semibold">
                {bp.icon} {{ youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' }[p] ?? (p.charAt(0).toUpperCase() + p.slice(1))}
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                <span className="text-muted-foreground">Best days</span>
                <span>{bp.bestDays}</span>
                <span className="text-muted-foreground">Best times</span>
                <span>{bp.bestTimes}</span>
                <span className="text-muted-foreground">Frequency</span>
                <span>{bp.frequency}</span>
              </div>
              <p className="text-[10px] text-muted-foreground/70 pt-0.5 border-t border-border/30 leading-relaxed">
                {bp.tip}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
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
    complete:        'bg-green-950/60 text-green-400 border border-green-800/60',
    staged:            'bg-blue-950/60 text-blue-400 border border-blue-800/60',
    operator_review:   'bg-blue-950/60 text-blue-400 border border-blue-800/60',
    processing:        'bg-blue-950/60 text-blue-400 border border-blue-800/60',
    running:   'bg-yellow-950/60 text-yellow-400 border border-yellow-800/60',
    queued:    'bg-muted/60 text-muted-foreground border border-border/60',
    failed:    'bg-red-950/60 text-red-400 border border-red-800/60',
    published: 'bg-violet-950/60 text-violet-400 border border-violet-800/60',
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${variants[status] ?? 'bg-muted/60 text-muted-foreground border border-border/60'}`}>
      {jobStatusLabel(status)}
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
              <span className="ml-1 text-muted-foreground">— {portalStatusLabel(r.status)}</span>
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

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function nextOccurrence(slot: ScheduleSlot): Date {
  const now = new Date();
  const [hh, mm] = slot.time.split(':').map(Number);
  if (slot.day === -1) {
    // daily — next occurrence is today at slot.time if still in the future, else tomorrow
    const candidate = new Date(now);
    candidate.setHours(hh, mm, 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }
  // specific weekday
  const candidate = new Date(now);
  candidate.setHours(hh, mm, 0, 0);
  const diff = ((slot.day - now.getDay()) + 7) % 7;
  candidate.setDate(candidate.getDate() + (diff === 0 && candidate <= now ? 7 : diff));
  return candidate;
}

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StagingPanel({ jobId, platforms, getToken, isSuperAdmin }: { jobId: string; platforms: string[]; getToken: () => Promise<string | null>; isSuperAdmin: boolean }) {
  const [assets, setAssets]     = useState<StagingAssets | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ error?: string | null } | null>(null);
  const [showScript, setShowScript] = useState(false);
  const [redoing, setRedoing]   = useState(false);
  const [redoResult, setRedoResult] = useState<{ ok?: boolean; error?: string } | null>(null);
  const [showScheduler, setShowScheduler] = useState(false);
  const [scheduleAt, setScheduleAt]       = useState('');
  const [scheduling, setScheduling]       = useState(false);
  const [scheduleResult, setScheduleResult] = useState<{ ok?: boolean; at?: string; error?: string } | null>(null);
  const [savedPrefs, setSavedPrefs]       = useState<SchedulePrefs>({});

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const [data, { prefs }] = await Promise.all([
          apiFetch<StagingAssets & { ok?: boolean }>(
            `/jobs/${jobId}/staging-assets`,
            { token: token ?? undefined }
          ),
          getSchedulePrefs(token ?? undefined),
        ]);
        setAssets(data);
        setSavedPrefs(prefs ?? {});
      } catch (e: unknown) {
        setError('Failed to load review assets. Please refresh and try again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [jobId, getToken]);

  const handleApprovePublish = useCallback(async () => {
    if (!assets) return;
    setPublishing(true);
    try {
      const token = await getToken();
      const result = await apiFetch<Record<string, unknown>>(
        `/jobs/${jobId}/approve-publish`,
        {
          method: 'POST',
          body: JSON.stringify({ platforms: assets.input.platforms }),
          token: token ?? undefined,
        }
      );
      setPublishResult(result);
    } catch {
      setPublishResult({ error: 'Publish failed. Please try again.' });
    } finally {
      setPublishing(false);
    }
  }, [assets, jobId, getToken]);

  const handleApproveSchedule = useCallback(async () => {
    if (!scheduleAt) return;
    const iso = new Date(scheduleAt).toISOString();
    setScheduling(true);
    try {
      const token = await getToken();
      await updateJobSchedule(jobId, 'scheduled', iso, token ?? undefined);
      setScheduleResult({ ok: true, at: iso });
      setShowScheduler(false);
    } catch {
      setScheduleResult({ error: 'Schedule failed. Please try again.' });
    } finally {
      setScheduling(false);
    }
  }, [scheduleAt, jobId, getToken]);

  const handleRequestRedo = useCallback(async () => {
    setRedoing(true);
    try {
      const token = await getToken();
      await apiFetch(`/jobs/${jobId}/retry`, { method: 'POST', token: token ?? undefined });
      setRedoResult({ ok: true });
    } catch {
      setRedoResult({ error: 'Redo request failed. Please try again.' });
    } finally {
      setRedoing(false);
    }
  }, [jobId, getToken]);

  if (loading) return <p className="text-xs text-muted-foreground py-4 text-center">Loading review assets…</p>;
  if (error)   return <p className="text-xs text-red-600 py-4">{formatUserError(error)}</p>;
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
            <dd>{labelForContentType(input.contentType ?? '')}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd>{entryTypeLabel(input.sourceType)}</dd>
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
                {!!wc.entryType    && <p><span className="text-muted-foreground">Source type:</span> {entryTypeLabel(String(wc.entryType))}</p>}
                {wc.durationMins != null && <p><span className="text-muted-foreground">Duration:</span> {String(wc.durationMins)} min</p>}
                {wc.creditCost != null && <p><span className="text-muted-foreground">Credit cost:</span> {String(wc.creditCost)}</p>}
                {!!wc.publishMode  && <p><span className="text-muted-foreground">Publish:</span> <span className="capitalize">{String(wc.publishMode)}{wc.scheduledAt ? ` — ${new Date(String(wc.scheduledAt)).toLocaleDateString()}` : ''}</span></p>}
                {allFeatures.length > 0 && (
                  <p><span className="text-muted-foreground">Features:</span> {allFeatures.map((f) => f.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())).join(', ')}</p>
                )}
                {platforms.length > 0 && (
                  <p><span className="text-muted-foreground">Platforms:</span> {platforms.map(platformLabel).join(', ')}</p>
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

      {/* Production steps — superadmin only */}
      {isSuperAdmin && (
        <div>
          <p className="text-xs font-semibold mb-2 text-muted-foreground">Production pipeline</p>
          <PortalTimeline reports={portalReports} />
        </div>
      )}

      <Separator />

      {/* Actions — Approve, Schedule, Download, Redo */}
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

        {/* Schedule result */}
        {scheduleResult && (
          <div className="rounded-md border p-3 text-xs">
            {scheduleResult.error
              ? <p className="text-red-600">{scheduleResult.error}</p>
              : <p className="text-green-600">
                  Scheduled for {new Date(scheduleResult.at!).toLocaleString()} — you&apos;ll find it in the Schedule section.
                </p>}
          </div>
        )}

        {/* Redo result */}
        {redoResult && (
          <div className="rounded-md border p-3 text-xs">
            {redoResult.error
              ? <p className="text-red-600">{formatUserError(redoResult.error)}</p>
              : <p className="text-blue-600">Redo requested — job re-queued for processing.</p>}
          </div>
        )}

        {/* Schedule date picker */}
        {showScheduler && !scheduleResult && (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
            <p className="text-xs font-semibold">Choose a publish date and time</p>

            {/* Saved slot chips — only for platforms on this job */}
            {(() => {
              const chips = platforms.flatMap((p) =>
                (savedPrefs[p as keyof SchedulePrefs] ?? []).map((s) => ({ platform: p, slot: s }))
              );
              if (chips.length === 0) return null;
              return (
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Your saved slots</p>
                  <div className="flex flex-wrap gap-2">
                    {chips.map(({ platform, slot }, i) => {
                      const next = nextOccurrence(slot);
                      return (
                        <button
                          key={i}
                          onClick={() => setScheduleAt(toDatetimeLocal(next))}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1 text-xs hover:border-primary/60 hover:bg-accent transition-colors"
                        >
                          <span className="capitalize text-muted-foreground">{platform}</span>
                          {slot.day === -1 ? 'Daily' : DAY_NAMES[slot.day]} {slot.time}
                          <span className="text-muted-foreground/60">→ {next.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            <input
              type="datetime-local"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              min={(() => {
                const d = new Date(); d.setMinutes(d.getMinutes() + 30);
                return d.toISOString().slice(0, 16);
              })()}
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={!scheduleAt || scheduling}
                onClick={handleApproveSchedule}
              >
                {scheduling ? 'Scheduling…' : 'Confirm schedule'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setShowScheduler(false); setScheduleAt(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {/* Approve & Publish */}
          {!publishResult && !scheduleResult && (
            <Button
              size="sm"
              disabled={!canPublish || publishing}
              onClick={handleApprovePublish}
            >
              {publishing ? 'Publishing…' : 'Approve & Publish'}
            </Button>
          )}

          {/* Schedule for later */}
          {!publishResult && !scheduleResult && !showScheduler && (
            <Button
              size="sm"
              variant="outline"
              disabled={!canPublish}
              onClick={() => setShowScheduler(true)}
            >
              Schedule for later
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
          {!redoResult && assets.status !== 'published' && !scheduleResult && (
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
  const { getToken }             = useAuth();
  const { isSuperAdmin, isLoaded: roleLoaded } = useRole();
  const { activeBrand }          = useBrand();
  const activeBrandId            = activeBrand?.id;
  const [jobs, setJobs]         = useState<Job[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!roleLoaded) return;
    (async () => {
      try {
        const token = await getToken();
        const data = isSuperAdmin
          ? await apiFetch<{ jobs: Job[] }>('/jobs?all=true', { token: token ?? undefined })
          : await listJobs(token ?? undefined);
        const withOutput = (data.jobs ?? []).filter(isReviewQueueJob);
        withOutput.sort((a, b) => {
          const toMs = (v: string | number | undefined) => {
            if (v == null) return 0;
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isNaN(n) && n > 0) return n > 1e12 ? n : n;
            const d = Date.parse(String(v));
            return Number.isNaN(d) ? 0 : d;
          };
          return toMs(b.createdAt) - toMs(a.createdAt);
        });
        setJobs(withOutput);
      } catch {
        setError('Failed to load jobs. Refresh to try again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken, isSuperAdmin, roleLoaded, activeBrandId]);

  function formatDate(ts: string | number) {
    const n = typeof ts === 'string' ? Number(ts) : ts;
    const d = n > 1e12 ? new Date(n) : new Date(ts);
    return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
  }

  // Collect all platforms across queued jobs to show relevant best practices
  const activePlatforms = [...new Set(jobs.flatMap((j) => j.platforms ?? []))];

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="Review Queue"
        subtitle={isSuperAdmin
          ? `Platform-wide — all accounts. ${jobs.length > 0 ? `${jobs.length} job${jobs.length === 1 ? '' : 's'} awaiting review.` : ''}`
          : activeBrand
            ? `${activeBrand.name}${activeBrand.is_primary === false ? ' sub-brand' : ''} — ${jobs.length > 0 ? `${jobs.length} job${jobs.length === 1 ? '' : 's'} ready to approve and publish.` : 'Videos ready for your review before publishing.'}`
            : 'Videos ready for your review before publishing to social platforms.'}
      />

      {(loading || !roleLoaded) && <p className="af-body text-muted-foreground">Loading jobs…</p>}
      {error   && <p className="af-body text-destructive">{formatUserError(error)}</p>}

      {/* Platform publish best practices */}
      {!loading && !isSuperAdmin && (
        <PublishBestPractices platforms={activePlatforms.length > 0 ? activePlatforms : ['youtube', 'tiktok', 'instagram']} />
      )}

      {!loading && !error && jobs.length === 0 && (
        <EmptyState
          title="Queue is clear"
          description="Once a job finishes processing, it will appear here for review before publishing."
          size="md"
        />
      )}

      {jobs.map((job) => {
        const isOpen = expanded === job.jobId;
        const primaryPlatform = job.platforms?.[0];
        const accentBorder: Record<string, string> = {
          youtube: 'border-l-red-500', tiktok: 'border-l-cyan-400',
          instagram: 'border-l-purple-500',
        };
        return (
          <div
            key={job.jobId}
            className={`rounded-xl border bg-card overflow-hidden border-l-4 ${accentBorder[primaryPlatform ?? ''] ?? 'border-l-indigo-500'} ${isOpen ? 'ring-1 ring-primary/20' : ''}`}
          >
            <div className="px-4 pt-4 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">
                      {jobDisplayTitle(job)}
                    </span>
                    <StatusBadge status={job.status} />
                    {job.platforms?.map((p) => (
                      <span key={p} className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-muted/60 text-muted-foreground border border-border/60">
                        {PLATFORM_ICONS[p] ?? '●'} {PLATFORM_DISPLAY[p] ?? p}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {isSuperAdmin && (job.customerName || job.customerId) && (
                      <span className="mr-1">{job.customerName ?? job.customerId!.slice(0, 12) + '…'} · </span>
                    )}
                    {formatDate(job.createdAt)}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Link href={`/myjobs/${job.jobId}`} className="text-xs text-muted-foreground hover:text-foreground">
                    Detail
                  </Link>
                  <button
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() => setExpanded(isOpen ? null : job.jobId)}
                  >
                    {isOpen ? 'Collapse ▲' : 'Review ▼'}
                  </button>
                </div>
              </div>
            </div>

            {isOpen && (
              <div className="px-4 pb-4 border-t border-border/50 pt-4">
                <StagingPanel jobId={job.jobId} platforms={job.platforms ?? []} getToken={getToken} isSuperAdmin={isSuperAdmin} />
              </div>
            )}
          </div>
        );
      })}
    </PageShell>
  );
}
