'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Job, PortalStatus } from '@/lib/api';

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_MAP: Record<Job['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  queued:    { label: 'Queued',     variant: 'secondary'   },
  running:   { label: 'Running',    variant: 'default'     },
  complete:  { label: 'Complete',   variant: 'default'     },
  failed:    { label: 'Failed',     variant: 'destructive' },
  held:      { label: 'On Hold',    variant: 'outline'     },
  staged:    { label: 'In Review',  variant: 'secondary'   },
  published: { label: 'Published',  variant: 'default'     },
  cancelled: { label: 'Cancelled',  variant: 'outline'     },
};

const PORTAL_STATUS_COLOR: Record<PortalStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
  pass:    'bg-green-500/20 text-green-700 dark:text-green-400',
  hold:    'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
  failed:  'bg-destructive/20 text-destructive',
  skipped: 'bg-muted text-muted-foreground/60',
};

const PORTALS = ['portal0', 'portal1', 'portal2', 'portal3a', 'portal3b', 'portal4', 'portal5'];

const PLATFORM_LABELS: Record<string, string> = {
  youtube:   'YouTube',
  tiktok:    'TikTok',
  instagram: 'Instagram',
};

const PORTAL_STEP_LABELS: Record<string, string> = {
  portal0:  'Source validation',
  portal1:  'Script generation',
  portal1b: 'Script review',
  portal2:  'Video assembly',
  portal3a: 'Assembly review',
  portal3b: 'Quality check',
  portal4:  'Broadcast QA',
  portal5:  'Delivery',
};

interface JobCardProps {
  job:      Job;
  detailed?: boolean;
}

export function JobCard({ job, detailed = false }: JobCardProps) {
  const statusCfg = STATUS_MAP[job.status] ?? { label: job.status, variant: 'secondary' as const };

  const portalMap = Object.fromEntries(
    (job.portalReports ?? []).map((r) => [r.portal, r])
  );

  return (
    <Link href={`/dashboard/jobs/${job.jobId}`} className="block">
    <Card className="hover:border-border/80 transition-colors cursor-pointer">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground font-mono truncate">{job.jobId}</p>
            <p className="text-sm font-medium mt-0.5">{job.contentType}</p>
          </div>
          <Badge variant={statusCfg.variant} className="text-xs shrink-0">
            {statusCfg.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Portal progress strip */}
        <div className="flex gap-0.5">
          {PORTALS.map((pid) => {
            const report = portalMap[pid];
            const st: PortalStatus = report?.status ?? 'pending';
            return (
              <div
                key={pid}
                title={`${pid}: ${st}`}
                className={cn(
                  'flex-1 h-1.5 rounded-full',
                  st === 'pass'    ? 'bg-green-500' :
                  st === 'running' ? 'bg-blue-500 animate-pulse' :
                  st === 'failed'  ? 'bg-destructive' :
                  st === 'hold'    ? 'bg-yellow-500' :
                  st === 'skipped' ? 'bg-muted' :
                  'bg-muted/40',
                )}
              />
            );
          })}
        </div>

        {/* Platform chips */}
        <div className="flex gap-1 flex-wrap">
          {job.platforms.map((p) => (
            <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {PLATFORM_LABELS[p] ?? p}
            </span>
          ))}
          {job.publishMode === 'scheduled' && job.scheduledPublishAt && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
              ⏰ {new Date(job.scheduledPublishAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
        </div>

        {/* Detailed portal breakdown — operator view */}
        {detailed && job.portalReports && job.portalReports.length > 0 && (
          <div className="space-y-1 pt-1 border-t border-border">
            {job.portalReports.map((r) => (
              <div key={r.portal} className="flex items-center gap-2 text-xs">
                <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', PORTAL_STATUS_COLOR[r.status])}>
                  {r.status}
                </span>
                <span className="text-muted-foreground">{PORTAL_STEP_LABELS[r.portal] ?? r.portal}</span>
                {r.score !== undefined && (
                  <span className="ml-auto text-muted-foreground">{r.score}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          {new Date(job.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </p>
      </CardContent>
    </Card>
    </Link>
  );
}
