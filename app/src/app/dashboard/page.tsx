import { currentUser } from '@clerk/nextjs/server';
import { Card, CardContent } from '@/components/ui/card';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PipelineStatusWidget } from '@/components/dashboard/pipeline-status-widget';

export default async function DashboardPage() {
  const user      = await currentUser();
  const firstName = user?.firstName ?? 'there';

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Welcome back, {firstName}</h1>
        <p className="text-muted-foreground text-sm mt-1">AuraFlux Content Operations Platform</p>
      </div>

      {/* Quick actions */}
      <div className="flex gap-3">
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
