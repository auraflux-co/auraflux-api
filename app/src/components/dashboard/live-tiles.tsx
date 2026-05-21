'use client';
/**
 * LiveTiles — dashboard home 3×2 grid with embedded live data per tile.
 *
 * One jobs fetch + one credits fetch + one templates fetch, distributed
 * across all six tiles so each tile shows real status on login.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import {
  listJobs,
  getCreditBalance,
  listTemplates,
  type Job,
  type CreditBalance,
} from '@/lib/api';

// ─── Shared data shape ────────────────────────────────────────────────────────

interface TileData {
  jobs:      Job[];
  balance:   CreditBalance | null;
  templates: number;
  loaded:    { jobs: boolean; credits: boolean; templates: boolean };
}

const EMPTY: TileData = {
  jobs:      [],
  balance:   null,
  templates: 0,
  loaded:    { jobs: false, credits: false, templates: false },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtCredits(n: number) {
  return n.toLocaleString();
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', color, pulse && 'animate-pulse')} />
  );
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cn('rounded bg-muted animate-pulse', className)} />;
}

// ─── Per-tile content ─────────────────────────────────────────────────────────

function JobsTileContent({ data }: { data: TileData }) {
  if (!data.loaded.jobs) return <Skeleton className="h-4 w-32 mt-1" />;
  const active  = data.jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const failed  = data.jobs.filter((j) => j.status === 'failed');
  if (active.length === 0 && failed.length === 0) {
    return <p className="text-xs text-muted-foreground mt-1">No active jobs — ready when you are</p>;
  }
  return (
    <div className="flex flex-col gap-1 mt-1">
      {active.length > 0 && (
        <span className="flex items-center gap-1.5 text-xs text-foreground">
          <Dot color="bg-blue-500" pulse />
          {active.length} {active.length === 1 ? 'job' : 'jobs'} in progress
        </span>
      )}
      {failed.length > 0 && (
        <span className="flex items-center gap-1.5 text-xs text-destructive">
          <Dot color="bg-destructive" />
          {failed.length} failed — needs attention
        </span>
      )}
    </div>
  );
}

function ReviewTileContent({ data }: { data: TileData }) {
  if (!data.loaded.jobs) return <Skeleton className="h-4 w-28 mt-1" />;
  const ready = data.jobs.filter((j) => j.status === 'complete' || j.status === 'staged').length;
  if (ready === 0) {
    return <p className="text-xs text-muted-foreground mt-1">Queue is clear</p>;
  }
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-primary mt-1">
      <Dot color="bg-primary" pulse />
      {ready} {ready === 1 ? 'job' : 'jobs'} ready to review
    </span>
  );
}

function ScheduleTileContent() {
  return <p className="text-xs text-muted-foreground mt-1">Set up your publishing calendar</p>;
}

function TemplatesTileContent({ data }: { data: TileData }) {
  if (!data.loaded.templates) return <Skeleton className="h-4 w-24 mt-1" />;
  if (data.templates === 0) {
    return <p className="text-xs text-muted-foreground mt-1">No templates saved yet</p>;
  }
  return (
    <p className="text-xs text-muted-foreground mt-1">
      {data.templates} {data.templates === 1 ? 'template' : 'templates'} saved
    </p>
  );
}

function BillingTileContent({ data }: { data: TileData }) {
  if (!data.loaded.credits) return <Skeleton className="h-4 w-36 mt-1" />;
  if (!data.balance) return <p className="text-xs text-muted-foreground mt-1">View usage and credits</p>;

  const { included_remaining, included_total, period_end } = data.balance;
  const pct  = included_total > 0 ? Math.min((1 - included_remaining / included_total) * 100, 100) : 0;
  const warn = pct >= 75;

  return (
    <div className="flex flex-col gap-1.5 mt-1">
      <div className="flex items-center gap-2">
        <span className={cn('text-xs font-medium tabular-nums', warn ? 'text-yellow-500' : 'text-foreground')}>
          {fmtCredits(included_remaining)}
          <span className="font-normal text-muted-foreground"> / {fmtCredits(included_total)} credits</span>
        </span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', warn ? 'bg-yellow-500' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">Renews {fmt(period_end)}</p>
    </div>
  );
}

function SettingsTileContent() {
  return <p className="text-xs text-muted-foreground mt-1">Channels, social accounts &amp; team</p>;
}

// ─── Tile icon + config ───────────────────────────────────────────────────────

const TILE_ICONS = {
  jobs: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18M9 21V9" />
    </svg>
  ),
  review: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  schedule: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    </svg>
  ),
  templates: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <path d="M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" />
    </svg>
  ),
  billing: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect width="22" height="16" x="1" y="4" rx="2" /><path d="M1 10h22" />
    </svg>
  ),
  settings: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
} as const;

// ─── Main component ───────────────────────────────────────────────────────────

export function LiveTiles() {
  const { getToken } = useAuth();
  const [data, setData] = useState<TileData>(EMPTY);

  const fetchJobs = useCallback(async (token: string | null) => {
    try {
      const res = await listJobs(token ?? undefined);
      setData((d) => ({ ...d, jobs: res.jobs ?? [], loaded: { ...d.loaded, jobs: true } }));
    } catch {
      setData((d) => ({ ...d, loaded: { ...d.loaded, jobs: true } }));
    }
  }, []);

  const fetchCredits = useCallback(async (token: string | null) => {
    try {
      const b = await getCreditBalance(token ?? undefined);
      setData((d) => ({ ...d, balance: b, loaded: { ...d.loaded, credits: true } }));
    } catch {
      setData((d) => ({ ...d, loaded: { ...d.loaded, credits: true } }));
    }
  }, []);

  const fetchTemplates = useCallback(async (token: string | null) => {
    try {
      const res = await listTemplates(token ?? undefined);
      setData((d) => ({ ...d, templates: (res.templates ?? []).length, loaded: { ...d.loaded, templates: true } }));
    } catch {
      setData((d) => ({ ...d, loaded: { ...d.loaded, templates: true } }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await getToken();
      if (cancelled) return;
      // Fire all three in parallel — no cascading waterfalls
      fetchJobs(token);
      fetchCredits(token);
      fetchTemplates(token);
    })();
    // Refresh jobs every 15s for active-job awareness
    const interval = setInterval(async () => {
      if (cancelled) return;
      const token = await getToken();
      if (!cancelled) fetchJobs(token);
    }, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [getToken, fetchJobs, fetchCredits, fetchTemplates]);

  const tiles = [
    {
      id:      'jobs',
      href:    '/dashboard/jobs',
      title:   'My Jobs',
      icon:    TILE_ICONS.jobs,
      content: <JobsTileContent data={data} />,
    },
    {
      id:      'review',
      href:    '/dashboard/staging',
      title:   'Review Queue',
      icon:    TILE_ICONS.review,
      content: <ReviewTileContent data={data} />,
    },
    {
      id:      'schedule',
      href:    '/dashboard/schedule',
      title:   'Schedule',
      icon:    TILE_ICONS.schedule,
      content: <ScheduleTileContent />,
    },
    {
      id:      'templates',
      href:    '/dashboard/templates',
      title:   'My Templates',
      icon:    TILE_ICONS.templates,
      content: <TemplatesTileContent data={data} />,
    },
    {
      id:      'billing',
      href:    '/dashboard/billing',
      title:   'Billing',
      icon:    TILE_ICONS.billing,
      content: <BillingTileContent data={data} />,
    },
    {
      id:      'settings',
      href:    '/dashboard/settings',
      title:   'Settings',
      icon:    TILE_ICONS.settings,
      content: <SettingsTileContent />,
    },
  ] as const;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {tiles.map((tile) => (
        <Link
          key={tile.id}
          href={tile.href}
          className={cn(
            'group relative flex flex-col justify-between rounded-xl border border-border bg-card',
            'p-6 min-h-[160px]',
            'transition-all duration-150 hover:border-primary/50 hover:bg-card/80 hover:shadow-md',
          )}
        >
          {/* Top row: icon + title */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-muted-foreground group-hover:text-primary transition-colors">
                {tile.icon}
              </span>
            </div>
            <p className="font-semibold text-sm leading-tight group-hover:text-primary transition-colors">
              {tile.title}
            </p>
            {tile.content}
          </div>

          {/* Arrow hint bottom-right */}
          <span className="self-end text-muted-foreground/30 group-hover:text-primary/50 transition-colors text-sm mt-4">
            →
          </span>
        </Link>
      ))}
    </div>
  );
}
