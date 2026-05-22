import Link from 'next/link';
import { currentUser } from '@clerk/nextjs/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

const API_KEYS    = { href: '/settings/api-keys',  title: 'My API Keys',        description: 'Create and manage API keys for the AuraFlux developer API.',                                         cta: 'Manage my API keys →'        };
const MY_CHANNELS = { href: '/settings/channels',  title: 'My Channels',        description: 'Save your default Twitch, Kick, and YouTube channels so the source picker pre-fills them.',        cta: 'Manage my channels →'        };
const SOCIAL      = { href: '/settings/social',    title: 'My Social Accounts', description: 'Connect YouTube, TikTok, and Instagram to publish directly without a third-party proxy.',          cta: 'Manage my social accounts →' };
const MY_TEAM     = { href: '/settings/team',      title: 'My Team',            description: 'Invite team members and manage their roles — Admin, Member, or Billing.',                           cta: 'Manage my team →'            };

function sectionsForTier(planTier: string | undefined) {
  if (planTier === 'operate') return [API_KEYS, MY_CHANNELS, SOCIAL, MY_TEAM];
  return [MY_CHANNELS, SOCIAL, MY_TEAM];
}

export default async function SettingsPage() {
  const user      = await currentUser();
  const planTier  = (user?.publicMetadata?.planTier as string | undefined) ?? undefined;
  const sections  = sectionsForTier(planTier);

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="Settings"
        subtitle="Manage your account integrations and access."
      />

      {sections.map((s) => (
        <Card key={s.href} className="hover:border-primary/30 transition-colors">
          <CardHeader className="pb-2">
            <CardTitle className="af-h3">{s.title}</CardTitle>
            <CardDescription className="af-body">{s.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href={s.href} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}>
              {s.cta}
            </Link>
          </CardContent>
        </Card>
      ))}
    </PageShell>
  );
}
