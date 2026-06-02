import Link from 'next/link';
import { currentUser } from '@clerk/nextjs/server';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

const API_KEYS    = {
  href: '/settings/api-keys',
  title: 'API Keys',
  description: 'Create and manage API keys for the AuraFlux developer API.',
  cta: 'Manage API keys →',
  icon: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
    </svg>
  ),
};
const MY_CHANNELS = {
  href: '/settings/channels',
  title: 'Source Channels',
  description: 'Save your default Twitch, Kick, and YouTube channels so the source picker pre-fills them.',
  cta: 'Manage channels →',
  icon: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75.125V5.625m0 12.75h.75M18.375 19.5h1.5c.621 0 1.125-.504 1.125-1.125M18.375 19.5v.125m1.5-13.875v13m0 0l.375-.375M3.375 5.625A1.125 1.125 0 014.5 4.5h15a1.125 1.125 0 011.125 1.125M3.375 5.625v.125M4.5 4.5L9 9m3 0l4.5-4.5m0 0l.375.375" />
    </svg>
  ),
};
const SOCIAL      = {
  href: '/settings/social',
  title: 'Social Accounts',
  description: 'Connect YouTube, TikTok, and Instagram to publish directly without a third-party proxy.',
  cta: 'Manage accounts →',
  icon: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
    </svg>
  ),
};
const MY_TEAM     = {
  href: '/settings/team',
  title: 'Team',
  description: 'Invite team members and manage their roles — Admin, Member, or Billing.',
  cta: 'Manage team →',
  icon: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
    </svg>
  ),
};

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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group rounded-xl border border-border bg-card p-5 flex flex-col gap-3 hover:border-primary/30 hover:shadow-sm transition-all"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary group-hover:bg-primary/15 transition-colors">
                {s.icon}
              </div>
              <span className="text-muted-foreground/50 group-hover:text-primary/60 transition-colors text-lg mt-1">→</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{s.title}</p>
              <p className="af-caption text-muted-foreground mt-1">{s.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </PageShell>
  );
}
