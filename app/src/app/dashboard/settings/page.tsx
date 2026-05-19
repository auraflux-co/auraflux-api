import Link from 'next/link';
import { currentUser } from '@clerk/nextjs/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const API_KEYS    = { href: '/dashboard/settings/api-keys',        title: 'API Keys',        description: 'Create and manage API keys for the AuraFlux developer API.',                                             cta: 'Manage API keys →'        };
const MY_CHANNELS = { href: '/dashboard/settings/source-channels', title: 'My Channels',     description: 'Save your default Twitch, Kick, and YouTube channels so the source picker pre-fills them.',              cta: 'Manage my channels →'     };
const SOCIAL      = { href: '/dashboard/settings/social-connect',  title: 'Social Accounts', description: 'Connect YouTube, TikTok, and Instagram to publish directly without a third-party proxy.',                cta: 'Manage social accounts →' };
const MY_TEAM     = { href: '/dashboard/settings/team',            title: 'My Team',         description: 'Invite team members and manage their roles — Admin, Member, or Billing.',                                cta: 'Manage my team →'         };

function sectionsForTier(planTier: string | undefined) {
  if (planTier === 'operate') return [MY_CHANNELS, SOCIAL, API_KEYS, MY_TEAM];
  return [MY_CHANNELS, SOCIAL, MY_TEAM];
}

export default async function SettingsPage() {
  const user      = await currentUser();
  const planTier  = (user?.publicMetadata?.planTier as string | undefined) ?? undefined;
  const sections  = sectionsForTier(planTier);

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your account integrations and access.</p>
      </div>

      {sections.map((s) => (
        <Card key={s.href}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{s.title}</CardTitle>
            <CardDescription>{s.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href={s.href} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}>
              {s.cta}
            </Link>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
