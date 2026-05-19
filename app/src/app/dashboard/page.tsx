import { currentUser } from '@clerk/nextjs/server';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PipelineStatusWidget } from '@/components/dashboard/pipeline-status-widget';
import { SetupChecklist } from '@/components/dashboard/setup-checklist';
import { tierLabel } from '@/lib/tier-labels';

// Default links shown when planTier is unset or unknown — job-focused, not developer API links.
// Operate-specific API links only show when planTier is explicitly 'operate'.
const DEFAULT_QUICK_LINKS = [
  { label: 'New job',      href: '/dashboard/jobs/new', description: 'Start a new content production job' },
  { label: 'Review queue', href: '/dashboard/staging',  description: 'Review completed jobs before publishing' },
  { label: 'Credits',      href: '/dashboard/credits',  description: 'Check your remaining credits' },
];

const TIER_QUICK_LINKS: Record<string, { label: string; href: string; description: string }[]> = {
  operate: [
    { label: 'New job',      href: '/dashboard/jobs/new',                                            description: 'Start a new content production job' },
    { label: 'API keys',     href: '/dashboard/settings/api-keys',                                   description: 'Manage your API credentials' },
    { label: 'View credits', href: '/dashboard/credits',                                             description: 'Check your remaining credits' },
  ],
  guided: [
    { label: 'New job',      href: '/dashboard/jobs/new', description: 'Start a new content production job' },
    { label: 'Review queue', href: '/dashboard/staging',  description: 'Review completed jobs before publishing' },
    { label: 'Get help',     href: '/dashboard/support',  description: 'Chat with AuraFlux support' },
  ],
  managed: [
    { label: 'New job',      href: '/dashboard/jobs/new', description: 'Start a new content production job' },
    { label: 'Review queue', href: '/dashboard/staging',  description: 'Review completed jobs before publishing' },
    { label: 'Support',      href: '/dashboard/support',  description: 'Reach your account team' },
  ],
  custom: [
    { label: 'New job',      href: '/dashboard/jobs/new', description: 'Start a new content production job' },
    { label: 'Review queue', href: '/dashboard/staging',  description: 'Review completed jobs before publishing' },
    { label: 'Support',      href: '/dashboard/support',  description: 'Reach your account team' },
  ],
};

const TIER_BADGE_VARIANT: Record<string, string> = {
  operate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  guided:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  managed: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  custom:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

// Sparkles icon for New Job CTA
function SparklesIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  );
}

// List icon for All Jobs CTA
function ListIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" x2="21" y1="6"  y2="6"  />
      <line x1="8" x2="21" y1="12" y2="12" />
      <line x1="8" x2="21" y1="18" y2="18" />
      <line x1="3" x2="3.01" y1="6"  y2="6"  />
      <line x1="3" x2="3.01" y1="12" y2="12" />
      <line x1="3" x2="3.01" y1="18" y2="18" />
    </svg>
  );
}

export default async function DashboardPage() {
  const user            = await currentUser();
  const firstName       = user?.firstName ?? 'there';
  const planTier        = (user?.publicMetadata?.planTier as string) ?? 'operate';
  const quickLinks      = TIER_QUICK_LINKS[planTier] ?? DEFAULT_QUICK_LINKS;
  const setupDismissed  = !!(user?.publicMetadata?.setupDismissed);

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Welcome header — gradient name + inline plan badge */}
      <div>
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
      </div>

      {/* Setup checklist — hidden once dismissed or all steps complete */}
      <SetupChecklist setupDismissed={setupDismissed} planTier={planTier} />

      {/* Quick actions — icon + label */}
      <div className="flex gap-3 flex-wrap">
        <Link href="/dashboard/jobs/new" className={cn(buttonVariants({ size: 'sm' }), 'gap-2')}>
          <SparklesIcon />
          New job
        </Link>
        <Link href="/dashboard/jobs" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-2')}>
          <ListIcon />
          All jobs
        </Link>
      </div>

      {/* Quick links cards — arrow top-right + left-border hover accent */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {quickLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            target={link.href.startsWith('http') ? '_blank' : undefined}
            rel={link.href.startsWith('http') ? 'noopener noreferrer' : undefined}
            className="group relative rounded-lg border border-border bg-card px-4 py-3 transition-all hover:border-l-2 hover:border-l-primary hover:shadow-sm hover:bg-accent/20"
          >
            <span className="absolute right-3 top-3 text-muted-foreground/30 transition-all group-hover:text-primary group-hover:translate-x-0.5 group-hover:-translate-y-0.5 text-xs">
              →
            </span>
            <p className="text-sm font-medium pr-4">{link.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{link.description}</p>
          </Link>
        ))}
      </div>

      {/* Job status — no Card wrapper, separator above */}
      <div>
        <Separator className="mb-6" />
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Pipeline
          </h2>
        </div>
        <PipelineStatusWidget />
      </div>
    </div>
  );
}
