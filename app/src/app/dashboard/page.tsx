import { currentUser } from '@clerk/nextjs/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const QUICK_LINKS = [
  {
    title: 'New Job',
    description: 'Start a new content production job',
    href: '/dashboard/jobs/new',
    badge: null,
  },
  {
    title: 'AI Concierge',
    description: 'Get guided help building your job spec',
    href: '/dashboard/concierge',
    badge: 'dwy+',
  },
  {
    title: 'Schedule',
    description: 'View and manage your publish schedule',
    href: '/dashboard/schedule',
    badge: null,
  },
];

export default async function DashboardPage() {
  const user = await currentUser();
  const firstName = user?.firstName ?? 'there';

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Welcome back, {firstName}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          AuraFlux Content Operations Platform
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {QUICK_LINKS.map((item) => (
          <Card key={item.href} className="hover:border-border/80 transition-colors">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{item.title}</CardTitle>
                {item.badge && (
                  <Badge variant="secondary" className="text-xs">{item.badge}</Badge>
                )}
              </div>
              <CardDescription className="text-xs">{item.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                href={item.href}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full')}
              >
                Open
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>

      <div>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Pipeline Status
        </h2>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">
              No active jobs. <Link href="/dashboard/jobs/new" className="text-foreground underline underline-offset-2">Start one</Link>.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
