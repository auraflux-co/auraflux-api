'use client';
/**
 * LiveTiles — dashboard home 3×2 grid with embedded live data per tile.
 *
 * Cards are div wrappers (not Link wrappers) so individual CTA rows inside
 * each card are independently clickable. One parallel fetch per data source.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { usePlan } from '@/contexts/plan-context';
import { useRole } from '@/hooks/use-role';
import { useBrand } from '@/contexts/brand-context';
import { tierLabel } from '@/lib/tier-labels';
import { YouTubeIcon, TikTokIcon, InstagramIcon } from '@/components/icons/brand-icons';
import {
  listJobs,
  getCreditBalance,
  listTemplates,
  listConnectedAccounts,
  type Job,
  type CreditBalance,
  type ConnectedAccount,
} from '@/lib/api';

// ─── Data shape ───────────────────────────────────────────────────────────────

interface TileData {
  jobs:      Job[];
  balance:   CreditBalance | null;
  templates: number;
  accounts:  ConnectedAccount[];
  loaded:    { jobs: boolean; credits: boolean; templates: boolean; accounts: boolean };
}

const EMPTY: TileData = {
  jobs:      [],
  balance:   null,
  templates: 0,
  accounts:  [],
  loaded:    { jobs: false, credits: false, templates: false, accounts: false },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cn('rounded bg-muted/80 animate-pulse', className)} />;
}

// ─── Numeric stat ─────────────────────────────────────────────────────────────

function NumStat({
  count, label, loading, warn,
}: { count: number; label: string; loading: boolean; warn?: boolean }) {
  if (loading) return <Skeleton className="h-8 w-32" />;
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn(
        'text-[28px] font-bold tabular-nums leading-none',
        warn && count > 0 ? 'text-destructive' : count > 0 ? 'text-foreground' : 'text-foreground/40',
      )}>
        {count}
      </span>
      <span className="text-sm font-medium text-muted-foreground leading-none">{label}</span>
    </div>
  );
}

// ─── CTA row ─────────────────────────────────────────────────────────────────

function CtaRow({
  href, label, primary, dim,
}: { href: string; label: string; primary?: boolean; dim?: boolean }) {
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'flex items-center gap-1.5 text-[13px] leading-tight transition-colors',
        primary
          ? 'text-primary font-semibold hover:text-primary/75'
          : dim
            ? 'text-muted-foreground/50 hover:text-muted-foreground'
            : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0 mt-px">
        <path d="M1.5 5h7M5.5 1.5 9 5l-3.5 3.5"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </Link>
  );
}

// ─── CTA divider ─────────────────────────────────────────────────────────────

function CtaSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 mt-auto pt-3 border-t border-border/40">
      {children}
    </div>
  );
}

// ─── Card shell ───────────────────────────────────────────────────────────────

function TileCard({
  icon, title, titleHref, children,
}: {
  icon: React.ReactNode;
  title: string;
  titleHref: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'group flex flex-col rounded-xl border border-border bg-card',
      'px-6 pt-6 pb-5 min-h-[230px]',
      'transition-all duration-150 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5',
    )}>
      {/* Icon */}
      <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center shrink-0 group-hover:bg-primary/10 transition-colors">
        <span className="text-muted-foreground group-hover:text-primary transition-colors">
          {icon}
        </span>
      </div>

      {/* Title — clickable label above the number */}
      <Link
        href={titleHref}
        className="mt-3 text-[10px] font-bold tracking-[0.12em] uppercase text-muted-foreground/70 hover:text-primary transition-colors"
        onClick={(e) => e.stopPropagation()}
      >
        {title}
      </Link>

      {/* Body */}
      <div className="mt-2 flex flex-col gap-3 flex-1">
        {children}
      </div>
    </div>
  );
}

// ─── Social platform badges (Settings tile) ───────────────────────────────────

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  youtube:   <YouTubeIcon size={22} />,
  tiktok:    <TikTokIcon size={22} />,
  instagram: <InstagramIcon size={22} />,
};

function PlatformBadge({ platform, connected }: { platform: string; connected: boolean }) {
  return (
    <span
      title={`${platform}${connected ? ' (connected)' : ' (not connected)'}`
      }
      className={cn(
        'inline-flex items-center justify-center rounded-md transition-all',
        !connected && 'opacity-25 grayscale',
      )}
    >
      {PLATFORM_ICONS[platform] ?? (
        <span className="w-5 h-5 rounded bg-muted text-[9px] font-bold flex items-center justify-center text-muted-foreground">
          {platform[0].toUpperCase()}
        </span>
      )}
    </span>
  );
}

// ─── Per-tile bodies ──────────────────────────────────────────────────────────

function JobsTileBody({ data, isSuperAdmin }: { data: TileData; isSuperAdmin: boolean }) {
  const active  = data.jobs.filter((j) => ['running', 'queued'].includes(j.status)).length;
  const failed  = data.jobs.filter((j) => j.status === 'failed').length;
  const loading = !data.loaded.jobs;

  return (
    <>
      <NumStat count={active} label="active jobs" loading={loading} warn={false} />
      {/* CPD-588: failed = system error, not customer-actionable */}
      {!loading && failed > 0 && isSuperAdmin && (
        <p className="text-xs text-destructive -mt-1 font-medium">
          {failed} job{failed !== 1 ? 's' : ''} failed — needs attention
        </p>
      )}
      {!loading && failed > 0 && !isSuperAdmin && (
        <p className="text-xs text-muted-foreground -mt-1">
          System error — we&apos;re on it
        </p>
      )}
      <CtaSection>
        <CtaRow href="/myjobs/active" label="View active jobs" primary />
        <CtaRow href="/myjobs/new"    label="Create a new job" />
      </CtaSection>
    </>
  );
}

function ReviewTileBody({ data }: { data: TileData }) {
  const ready   = data.jobs.filter((j) => ['complete', 'staged'].includes(j.status)).length;
  const loading = !data.loaded.jobs;

  return (
    <>
      <NumStat count={ready} label="to review" loading={loading} />
      <p className="text-[12px] text-muted-foreground leading-relaxed -mt-1">
        Watch · Script · Publish copy · Approve · Download · Redo
      </p>
      <CtaSection>
        <CtaRow href="/review" label="Review now" primary={ready > 0} />
        <CtaRow href="/review" label="Approve & publish to social" dim />
      </CtaSection>
    </>
  );
}

function ScheduleTileBody({ data }: { data: TileData }) {
  const scheduled = data.jobs.filter((j) => j.status === 'queued_scheduled').length;
  const loading   = !data.loaded.jobs;

  return (
    <>
      <NumStat count={scheduled} label="videos scheduled" loading={loading} />
      <CtaSection>
        <CtaRow href="/schedule" label="Check schedule" primary={scheduled > 0} />
        <CtaRow href="/schedule" label="Save Time — Schedule Your Jobs" dim />
      </CtaSection>
    </>
  );
}

function TemplatesTileBody({ data }: { data: TileData }) {
  const count   = data.templates;
  const loading = !data.loaded.templates;

  return (
    <>
      <NumStat count={count} label="active templates" loading={loading} />
      <CtaSection>
        <CtaRow href="/templates" label="Manage templates" primary={count > 0} />
        <CtaRow href="/templates" label="Save Time — Create your first template" dim />
      </CtaSection>
    </>
  );
}

function BillingTileBody({ data }: { data: TileData }) {
  const { planTier } = usePlan();
  const balance  = data.balance;
  const loading  = !data.loaded.credits;
  const used     = balance ? balance.included_total - balance.included_remaining : 0;
  const pct      = balance && balance.included_total > 0
    ? Math.min(used / balance.included_total * 100, 100)
    : 0;
  const warn = pct >= 80;

  return (
    <>
      {/* Plan name */}
      <div>
        {planTier ? (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded text-[10px] font-bold tracking-widest uppercase bg-primary/15 text-primary">
            {tierLabel(planTier)}
          </span>
        ) : <Skeleton className="h-5 w-16" />}
      </div>

      {/* Credits */}
      {loading ? <Skeleton className="h-7 w-36" /> : balance ? (
        <div>
          <div className="flex items-baseline gap-1.5">
            <span className={cn('text-[28px] font-bold tabular-nums leading-none', warn ? 'text-yellow-400' : 'text-foreground')}>
              {balance.included_remaining.toLocaleString()}
            </span>
            <span className="text-sm text-muted-foreground">
              / {balance.included_total.toLocaleString()} credits
            </span>
          </div>
          <div className="mt-2 w-full h-1 rounded-full bg-muted overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', warn ? 'bg-yellow-400' : 'bg-primary')}
              style={{ width: `${100 - pct}%` }}
            />
          </div>
        </div>
      ) : null}

      <CtaSection>
        {balance && (
          <p className="text-[12px] text-muted-foreground">Renews {fmt(balance.period_end)}</p>
        )}
        <CtaRow href="/billing" label="Manage billing" />
      </CtaSection>
    </>
  );
}

function SettingsTileBody({ data }: { data: TileData }) {
  const platforms = ['youtube', 'tiktok', 'instagram'] as const;
  const connectedSet = new Set(data.accounts.map((a) => a.platform));
  const loading = !data.loaded.accounts;

  return (
    <>
      {/* Social platform icons */}
      {loading ? <Skeleton className="h-6 w-24" /> : (
        <div className="flex items-center gap-2">
          {platforms.map((p) => (
            <PlatformBadge key={p} platform={p} connected={connectedSet.has(p)} />
          ))}
          <span className="text-[11px] text-muted-foreground ml-0.5">social accounts</span>
        </div>
      )}

      <p className="text-[12px] text-muted-foreground leading-relaxed">
        Channels · Social · Team · Preferences
      </p>

      <CtaSection>
        <CtaRow href="/settings"                label="Update settings"       primary />
        <CtaRow href="/settings/social" label="Connect social accounts" />
      </CtaSection>
    </>
  );
}

// ─── Tile icons ───────────────────────────────────────────────────────────────

const ICONS = {
  jobs: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18M9 21V9" />
    </svg>
  ),
  review: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  schedule: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    </svg>
  ),
  templates: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <path d="M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" />
    </svg>
  ),
  billing: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect width="22" height="16" x="1" y="4" rx="2" /><path d="M1 10h22" />
    </svg>
  ),
  settings: (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
} as const;

// ─── Main component ───────────────────────────────────────────────────────────

export function LiveTiles() {
  const { getToken } = useAuth();
  const { activeBrand } = useBrand();
  const { isSuperAdmin } = useRole();
  const activeBrandId = activeBrand?.id;
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

  const fetchAccounts = useCallback(async (token: string | null) => {
    try {
      const res = await listConnectedAccounts(token ?? undefined);
      setData((d) => ({ ...d, accounts: res.accounts ?? [], loaded: { ...d.loaded, accounts: true } }));
    } catch {
      setData((d) => ({ ...d, loaded: { ...d.loaded, accounts: true } }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setData(EMPTY);
    (async () => {
      const token = await getToken();
      if (cancelled) return;
      fetchJobs(token);
      fetchCredits(token);
      fetchTemplates(token);
      fetchAccounts(token);
    })();
    const interval = setInterval(async () => {
      if (cancelled) return;
      const token = await getToken();
      if (!cancelled) fetchJobs(token);
    }, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [getToken, activeBrandId, fetchJobs, fetchCredits, fetchTemplates, fetchAccounts]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      <TileCard icon={ICONS.jobs}      title="My Jobs"      titleHref="/myjobs">
        <JobsTileBody data={data} isSuperAdmin={isSuperAdmin} />
      </TileCard>
      <TileCard icon={ICONS.review}    title="Review Queue" titleHref="/review">
        <ReviewTileBody data={data} />
      </TileCard>
      <TileCard icon={ICONS.schedule}  title="Schedule"     titleHref="/schedule">
        <ScheduleTileBody data={data} />
      </TileCard>
      <TileCard icon={ICONS.templates} title="My Templates" titleHref="/templates">
        <TemplatesTileBody data={data} />
      </TileCard>
      <TileCard icon={ICONS.billing}   title="Billing"      titleHref="/billing">
        <BillingTileBody data={data} />
      </TileCard>
      <TileCard icon={ICONS.settings}  title="Settings"     titleHref="/settings">
        <SettingsTileBody data={data} />
      </TileCard>
    </div>
  );
}
