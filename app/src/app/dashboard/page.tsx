import { currentUser } from '@clerk/nextjs/server';
import { Separator } from '@/components/ui/separator';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { PipelineStatusWidget } from '@/components/dashboard/pipeline-status-widget';
import { ReviewQueueWidget } from '@/components/dashboard/review-queue-widget';
import { CreditsSummary } from '@/components/dashboard/credits-summary';
import { RecentJobsList } from '@/components/dashboard/recent-jobs-list';
import { SetupChecklist } from '@/components/dashboard/setup-checklist';
import { tierLabel } from '@/lib/tier-labels';

const TIER_BADGE_VARIANT: Record<string, string> = {
  operate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  guided:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  managed: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  custom:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

function SparklesIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  );
}

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
        <Badge className={cn('text-[11px] font-semibold uppercase tracking-wider', TIER_BADGE_VARIANT[planTier] ?? TIER_BADGE_VARIANT.operate)}>
          {tierLabel(planTier)}
        </Badge>
      </div>

      {/* ── Setup checklist — hidden once dismissed or complete ────── */}
      <SetupChecklist setupDismissed={setupDismissed} planTier={planTier} />

      {/* ── Signal row: Pipeline + Review queue ───────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Pipeline */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Pipeline
          </p>
          <PipelineStatusWidget />
        </div>

        {/* Review queue */}
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
            Review queue
          </p>
          <ReviewQueueWidget />
        </div>
      </div>

      {/* ── Credits bar ────────────────────────────────────────────── */}
      <CreditsSummary />

      {/* ── Recent jobs ────────────────────────────────────────────── */}
      <div>
        <Separator className="mb-6" />
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Recent jobs
          </h2>
        </div>
        <RecentJobsList />
      </div>

      {/* ── Primary CTA ────────────────────────────────────────────── */}
      <div>
        <Link href="/dashboard/jobs/new" className={cn(buttonVariants({ size: 'sm' }), 'gap-2')}>
          <SparklesIcon />
          New job
        </Link>
      </div>
    </div>
  );
}
