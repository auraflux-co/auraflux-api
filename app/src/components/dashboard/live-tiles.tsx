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

// ─── Per-tile status line ─────────────────────────────────────────────────────
// Each returns a compact status + a persistent description line below it.

function JobsTileBody({ data }: { data: TileData }) {
  const active = data.jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const failed = data.jobs.filter((j) => j.status === 'failed');

  return (
    <div className="flex flex-col gap-3 mt-4 flex-1">
      {/* Status */}
      <div className="min-h-[20px]">
        {!data.loaded.jobs ? (
          <Skeleton className="h-4 w-36" />
        ) : active.length > 0 ? (
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Dot color="bg-blue-500" pulse />
            {active.length} {active.length === 1 ? 'job' : 'jobs'} in progress
          </span>
        ) : failed.length > 0 ? (
          <span className="flex items-center gap-2 text-sm font-medium text-destructive">
            <Dot color="bg-destructive" />
            {failed.length} failed — needs attention
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">No active jobs</span>
        )}
      </div>
      {/* Description */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        Create and track all your video production jobs.
      </p>
    </div>
  );
}

function ReviewTileBody({ data }: { data: TileData }) {
  const ready = data.jobs.filter((j) => j.status === 'complete' || j.status === 'staged').length;

  return (
    <div className="flex flex-col gap-3 mt-4 flex-1">
      <div className="min-h-[20px]">
        {!data.loaded.jobs ? (
          <Skeleton className="h-4 w-32" />
        ) : ready > 0 ? (
          <span className="flex items-center gap-2 text-sm font-medium text-primary">
            <Dot color="bg-primary" pulse />
            {ready} {ready === 1 ? 'job' : 'jobs'} ready to review
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Queue is clear</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Approve, edit, or publish completed outputs.
      </p>
    </div>
  );
}

function ScheduleTileBody() {
  return (
    <div className="flex flex-col gap-3 mt-4 flex-1">
      <div className="min-h-[20px]">
        <span className="text-sm text-muted-foreground">Plan ahead</span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Set up your content publishing calendar and automate recurring posts.
      </p>
    </div>
  );
}

function TemplatesTileBody({ data }: { data: TileData }) {
  return (
    <div className="flex flex-col gap-3 mt-4 flex-1">
      <div className="min-h-[20px]">
        {!data.loaded.templates ? (
          <Skeleton className="h-4 w-28" />
        ) : data.templates > 0 ? (
          <span className="text-sm text-foreground">
            {data.templates} {data.templates === 1 ? 'template' : 'templates'} saved
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">No templates yet</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Save job configurations and automate recurring content.
      </p>
    </div>
  );
}

function BillingTileBody({ data }: { data: TileData }) {
  const balance = data.balance;
  const pct     = balance && balance.included_total > 0
    ? Math.min((1 - balance.included_remaining / balance.included_total) * 100, 100)
    : 0;
  const warn = pct >= 75;

  return (
    <div className="flex flex-col gap-3 mt-4 flex-1">
      <div className="min-h-[20px]">
        {!data.loaded.credits ? (
          <Skeleton className="h-4 w-40" />
        ) : balance ? (
          <span className={cn('text-sm font-medium tabular-nums', warn ? 'text-yellow-500' : 'text-foreground')}>
            {fmtCredits(balance.included_remaining)}
            <span className="font-normal text-muted-foreground text-xs"> / {fmtCredits(balance.included_total)} credits</span>
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">View your credits</span>
        )}
      </div>

      {balance && (
        <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', warn ? 'bg-yellow-500' : 'bg-primary')}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground leading-relaxed">
        {balance ? `Renews ${fmt(balance.period_end)}` : 'Credits, usage, and subscription management.'}
      </p>
    </div>
  );
}

function SettingsTileBody() {
  return (
    <div className="flex flex-col gap-3 mt-4 flex-1">
      <div className="min-h-[20px]">
        <span className="text-sm text-muted-foreground">Configure your account</span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        My Channels, Social Accounts, team members, and preferences.
      </p>
    </div>
  );
}

// ─── Tile icon + config ───────────────────────────────────────────────────────

const TILE_ICONS = {
  jobs: (
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18M9 21V9" />
    </svg>
  ),
  review: (
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  schedule: (
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    </svg>
  ),
  templates: (
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <path d="M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" />
    </svg>
  ),
  billing: (
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect width="22" height="16" x="1" y="4" rx="2" /><path d="M1 10h22" />
    </svg>
  ),
  settings: (
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
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
    { id: 'jobs',      href: '/dashboard/jobs',      title: 'My Jobs',       icon: TILE_ICONS.jobs,      body: <JobsTileBody data={data} />     },
    { id: 'review',    href: '/dashboard/staging',   title: 'Review Queue',  icon: TILE_ICONS.review,    body: <ReviewTileBody data={data} />   },
    { id: 'schedule',  href: '/dashboard/schedule',  title: 'Schedule',      icon: TILE_ICONS.schedule,  body: <ScheduleTileBody />             },
    { id: 'templates', href: '/dashboard/templates', title: 'My Templates',  icon: TILE_ICONS.templates, body: <TemplatesTileBody data={data} />},
    { id: 'billing',   href: '/dashboard/billing',   title: 'Billing',       icon: TILE_ICONS.billing,   body: <BillingTileBody data={data} />  },
    { id: 'settings',  href: '/dashboard/settings',  title: 'Settings',      icon: TILE_ICONS.settings,  body: <SettingsTileBody />             },
  ] as const;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {tiles.map((tile) => (
        <Link
          key={tile.id}
          href={tile.href}
          className={cn(
            'group flex flex-col rounded-xl border border-border bg-card',
            'p-7 min-h-[220px]',
            'transition-all duration-150 hover:border-primary/40 hover:bg-card/80 hover:shadow-md',
          )}
        >
          {/* Icon in muted container */}
          <div className="w-11 h-11 rounded-lg bg-muted/60 flex items-center justify-center shrink-0 group-hover:bg-primary/10 transition-colors">
            <span className="text-muted-foreground group-hover:text-primary transition-colors">
              {tile.icon}
            </span>
          </div>

          {/* Title */}
          <p className="mt-4 font-semibold text-base leading-tight group-hover:text-primary transition-colors">
            {tile.title}
          </p>

          {/* Body — status + description */}
          {tile.body}

          {/* Arrow hint */}
          <div className="flex justify-end mt-4">
            <span className="text-xs text-muted-foreground/40 group-hover:text-primary/60 transition-colors">
              →
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
