import { currentUser } from '@clerk/nextjs/server';
import { Card, CardContent } from '@/components/ui/card';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PipelineStatusWidget } from '@/components/dashboard/pipeline-status-widget';
import { tierLabel } from '@/lib/tier-labels';

const TIER_QUICK_LINKS: Record<string, { label: string; href: string; description: string }[]> = {
  operate: [
    { label: 'API docs',       href: 'https://robertsworkspace-18914505.atlassian.net/wiki/spaces/AF', description: 'Browse the AuraFlux API reference' },
    { label: 'API keys',       href: '/dashboard/settings/api-keys', description: 'Manage your API credentials' },
    { label: 'View credits',   href: '/dashboard/credits',           description: 'Check your remaining credits' },
  ],
  guided: [
    { label: 'New job',        href: '/dashboard/jobs/new',     description: 'Start a new content production job' },
    { label: 'Review queue',   href: '/dashboard/staging',      description: 'Review completed jobs before publishing' },
    { label: 'Get help',       href: '/dashboard/support',      description: 'Chat with AuraFlux support' },
  ],
  managed: [
    { label: 'New job',        href: '/dashboard/jobs/new',     description: 'Start a new content production job' },
    { label: 'Review queue',   href: '/dashboard/staging',      description: 'Review completed jobs before publishing' },
    { label: 'Support',        href: '/dashboard/support',      description: 'Reach your account team' },
  ],
  custom: [
    { label: 'New job',        href: '/dashboard/jobs/new',     description: 'Start a new content production job' },
    { label: 'Review queue',   href: '/dashboard/staging',      description: 'Review completed jobs before publishing' },
    { label: 'Support',        href: '/dashboard/support',      description: 'Reach your account team' },
  ],
};

const TIER_BADGE_COLORS: Record<string, string> = {
  operate:    'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  guided:    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  managed:    'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  custom: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

export default async function DashboardPage() {
  const user      = await currentUser();
  const firstName = user?.firstName ?? 'there';
  const planTier  = (user?.publicMetadata?.planTier as string) ?? 'operate';
  const quickLinks = TIER_QUICK_LINKS[planTier] ?? TIER_QUICK_LINKS.operate;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Welcome back, {firstName}</h1>
          <p className="text-muted-foreground text-sm mt-1">AuraFlux Content Operations Platform</p>
        </div>
        <span className={cn('shrink-0 mt-1 inline-block px-2.5 py-1 rounded-full text-xs font-semibold', TIER_BADGE_COLORS[planTier] ?? TIER_BADGE_COLORS.operate)}>
          {tierLabel(planTier)}
        </span>
      </div>

      {/* Quick actions */}
      <div className="flex gap-3 flex-wrap">
        <Link
          href="/dashboard/jobs/new"
          className={cn(buttonVariants({ size: 'sm' }))}
        >
          + New job
        </Link>
        <Link
          href="/dashboard/jobs"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        >
          All jobs
        </Link>
      </div>

      {/* Tier-relevant quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {quickLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            target={link.href.startsWith('http') ? '_blank' : undefined}
            rel={link.href.startsWith('http') ? 'noopener noreferrer' : undefined}
            className="rounded-lg border border-border bg-card px-4 py-3 hover:border-primary/40 hover:bg-accent/30 transition-colors group"
          >
            <p className="text-sm font-medium group-hover:text-primary transition-colors">{link.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{link.description}</p>
          </Link>
        ))}
      </div>

      {/* Job status — customer view */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">Job Status</h2>
        <Card>
          <CardContent className="pt-4">
            <PipelineStatusWidget />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
