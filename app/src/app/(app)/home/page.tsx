import { currentUser } from '@clerk/nextjs/server';
import { Suspense } from 'react';
import { SetupChecklist } from '@/components/dashboard/setup-checklist';
import { LiveTiles } from '@/components/dashboard/live-tiles';
import { FleetRosterPanel } from '@/components/dashboard/fleet-roster-panel';
import { CheckoutWelcomeBanner } from '@/components/dashboard/checkout-welcome-banner';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { tierLabel } from '@/lib/tier-labels';

const TIER_BADGE_COLORS: Record<string, string> = {
  operate: 'bg-slate-800/60 text-slate-300 border border-slate-700',
  guided:  'bg-blue-900/40 text-blue-300 border border-blue-700/50',
  managed: 'bg-violet-900/40 text-violet-300 border border-violet-700/50',
  custom:  'bg-primary/15 text-primary border border-primary/30',
};

export default async function DashboardPage() {
  const user           = await currentUser();
  const firstName      = user?.firstName ?? 'there';
  const planTier       = (user?.publicMetadata?.planTier as string) ?? 'operate';
  const setupDismissed = !!(user?.publicMetadata?.setupDismissed);
  const isSuperAdmin   = user?.publicMetadata?.role === 'superadmin';

  const tierBadge = (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-bold tracking-widest uppercase ${TIER_BADGE_COLORS[planTier] ?? TIER_BADGE_COLORS.operate}`}>
      {tierLabel(planTier)}
    </span>
  );

  return (
    <PageShell>
      <PageHeader
        title={`Welcome back, ${firstName}`}
        badge={tierBadge}
      />
      {/* CPD-401: welcome banner shown once after first subscription checkout */}
      <Suspense>
        <CheckoutWelcomeBanner firstName={firstName} />
      </Suspense>
      {!isSuperAdmin && <SetupChecklist setupDismissed={setupDismissed} planTier={planTier} />}
      <FleetRosterPanel />
      <LiveTiles />
    </PageShell>
  );
}
