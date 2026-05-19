import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const SETTINGS_SECTIONS = [
  {
    href:        '/dashboard/settings/api-keys',
    title:       'API Keys',
    description: 'Create and manage API keys for the AuraFlux developer API.',
    cta:         'Manage API keys →',
  },
  {
    href:        '/dashboard/settings/social-connect',
    title:       'Social Accounts',
    description: 'Connect YouTube, TikTok, and Instagram to publish directly without a third-party proxy.',
    cta:         'Manage social accounts →',
  },
  {
    href:        '/dashboard/settings/team',
    title:       'Team',
    description: 'Invite team members and manage their roles — Admin, Member, or Billing.',
    cta:         'Manage team →',
  },
  {
    href:        '/dashboard/settings/source-channels',
    title:       'Source Channels',
    description: 'Save your default Twitch, Kick, and YouTube channels so the source picker pre-fills them.',
    cta:         'Manage source channels →',
  },
];

export default function SettingsPage() {
  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your account integrations and access.</p>
      </div>

      {SETTINGS_SECTIONS.map((s) => (
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
