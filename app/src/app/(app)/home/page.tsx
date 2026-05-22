import { currentUser } from '@clerk/nextjs/server';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SetupChecklist } from '@/components/dashboard/setup-checklist';
import { LiveTiles } from '@/components/dashboard/live-tiles';
import { tierLabel } from '@/lib/tier-labels';

const TIER_BADGE_VARIANT: Record<string, string> = {
  operate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  guided:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  managed: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  custom:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

export default async function DashboardPage() {
  const user           = await currentUser();
  const firstName      = user?.firstName ?? 'there';
  const planTier       = (user?.publicMetadata?.planTier as string) ?? 'operate';
  const setupDismissed = !!(user?.publicMetadata?.setupDismissed);

  return (
    <div className="space-y-8 max-w-5xl">
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

      {/* ── Live dashboard tiles ─────────────────────────────────────── */}
      <LiveTiles />
    </div>
  );
}
