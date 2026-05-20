import { currentUser } from '@clerk/nextjs/server';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SetupChecklist } from '@/components/dashboard/setup-checklist';
import { ReviewCountBadge } from '@/components/dashboard/review-count-badge';
import { tierLabel } from '@/lib/tier-labels';

const TIER_BADGE_VARIANT: Record<string, string> = {
  operate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  guided:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  managed: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  custom:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

// ─── Nav tile definitions ─────────────────────────────────────────────────────

const TILES = [
  {
    id:   'jobs',
    href: '/dashboard/jobs',
    title: 'My Jobs',
    description: 'Create and track all your video production jobs.',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M3 9h18M9 21V9" />
      </svg>
    ),
  },
  {
    id:   'review',
    href: '/dashboard/staging',
    title: 'Review Queue',
    description: 'Approve, reject, or publish completed outputs.',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
    badge: <ReviewCountBadge />,
  },
  {
    id:   'schedule',
    href: '/dashboard/schedule',
    title: 'Schedule',
    description: 'Plan and automate your content publishing calendar.',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      </svg>
    ),
  },
  {
    id:   'templates',
    href: '/dashboard/templates',
    title: 'Templates',
    description: 'Save job configurations and automate recurring content.',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
        <path d="M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" />
      </svg>
    ),
  },
  {
    id:   'billing',
    href: '/dashboard/billing',
    title: 'Billing',
    description: 'Credits, usage, and subscription management.',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect width="22" height="16" x="1" y="4" rx="2" />
        <path d="M1 10h22" />
      </svg>
    ),
  },
  {
    id:   'settings',
    href: '/dashboard/settings',
    title: 'Settings',
    description: 'Channels, social accounts, team, and preferences.',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
] as const;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const user           = await currentUser();
  const firstName      = user?.firstName ?? 'there';
  const planTier       = (user?.publicMetadata?.planTier as string) ?? 'operate';
  const setupDismissed = !!(user?.publicMetadata?.setupDismissed);

  return (
    <div className="space-y-8 max-w-4xl">
      {/* ── Welcome header ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold tracking-tight">
          Welcome back,{' '}
          <span className="bg-gradient-to-r from-foreground via-foreground/80 to-foreground/60 bg-clip-text text-transparent">
            {firstName}
          </span>
        </h1>
        <Badge className={cn(
          'text-[11px] font-semibold uppercase tracking-wider',
          TIER_BADGE_VARIANT[planTier] ?? TIER_BADGE_VARIANT.operate,
        )}>
          {tierLabel(planTier)}
        </Badge>
      </div>

      {/* ── Setup checklist — hidden once dismissed or complete ────── */}
      <SetupChecklist setupDismissed={setupDismissed} planTier={planTier} />

      {/* ── 3×2 nav grid ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {TILES.map((tile) => (
          <Link
            key={tile.id}
            href={tile.href}
            className={cn(
              'group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-5',
              'transition-all duration-150 hover:border-primary/50 hover:bg-card/80 hover:shadow-sm',
            )}
          >
            {/* Icon + optional count badge */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground group-hover:text-primary transition-colors">
                {tile.icon}
              </span>
              {'badge' in tile && tile.badge}
            </div>

            {/* Title */}
            <div>
              <p className="font-semibold text-sm leading-tight group-hover:text-primary transition-colors">
                {tile.title}
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {tile.description}
              </p>
            </div>

            {/* Arrow hint */}
            <span className="absolute bottom-4 right-4 text-muted-foreground/30 group-hover:text-primary/50 transition-colors text-sm">
              →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
