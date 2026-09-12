'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/clerk-compat';
import { useBrand } from '@/contexts/brand-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { cn } from '@/lib/utils';
import {
  apiFetch,
  getBrands,
  getChannelConnections,
  getSourceChannels,
  listConnectedAccounts,
  type ConnectedAccount,
} from '@/lib/api';
import { SettingsDrawers, type DrawerKey } from '@/components/settings/settings-drawers';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://auraflux-api.onrender.com';

type HubStatus = {
  brandReady: number;
  brandTotal: number;
  channelsReady: number;
  channelsTotal: number;
  socialReady: number;
  socialTotal: number;
  socialExpired: number;
  teamCount: number;
};

const FALLBACK_STATUS: HubStatus = {
  brandReady: 0,
  brandTotal: 3,
  channelsReady: 0,
  channelsTotal: 3,
  socialReady: 0,
  socialTotal: 3,
  socialExpired: 0,
  teamCount: 1,
};

type HealthState = {
  api: 'ok' | 'degraded' | 'down' | 'loading';
  apiVersion?: string;
  checkedAt?: string;
};

type SectionId = 'brand' | 'channels' | 'social' | 'team' | 'api-keys';

type SectionDef = {
  id: SectionId;
  title: string;
  description: string;
  drawer?: DrawerKey;
  href?: string;
  icon: React.ReactElement;
};

const SECTIONS: SectionDef[] = [
  {
    id: 'brand',
    title: 'Brand',
    description: 'Upload your brand logo, intro card, and outro card — applied to every assembled video.',
    drawer: 'brand',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
      </svg>
    ),
  },
  {
    id: 'channels',
    title: 'Source Channels',
    description: 'Save your default Twitch, Kick, and YouTube channels so the source picker pre-fills them.',
    drawer: 'channels',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75.125V5.625m0 12.75h.75M18.375 19.5h1.5c.621 0 1.125-.504 1.125-1.125M18.375 19.5v.125m1.5-13.875v13m0 0l.375-.375M3.375 5.625A1.125 1.125 0 014.5 4.5h15a1.125 1.125 0 011.125 1.125M3.375 5.625v.125M4.5 4.5L9 9m3 0l4.5-4.5m0 0l.375.375" />
      </svg>
    ),
  },
  {
    id: 'social',
    title: 'Social Accounts',
    description: 'Connect YouTube, TikTok, and Instagram to publish directly without a third-party proxy.',
    drawer: 'social',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
      </svg>
    ),
  },
  {
    id: 'team',
    title: 'Team',
    description: 'Invite team members and manage their roles — Admin, Editor, or Viewer.',
    drawer: 'team',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>
    ),
  },
  {
    id: 'api-keys',
    title: 'API Keys',
    description: 'Create and manage API keys for the AuraFlux developer API.',
    href: '/settings/api-keys',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
      </svg>
    ),
  },
];

function statusBadge(sectionId: SectionId, status: HubStatus, pending: boolean) {
  if (pending) {
    return (
      <Badge variant="outline" className="text-slate-400 border-slate-700 bg-slate-800/50 text-[10px]">
        Checking…
      </Badge>
    );
  }
  if (sectionId === 'brand') {
    const ok = status.brandReady === status.brandTotal;
    return (
      <Badge
        variant="outline"
        className={cn(
          'text-[10px]',
          ok
            ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
            : 'text-amber-400 border-amber-500/30 bg-amber-500/10',
        )}
      >
        {status.brandReady} / {status.brandTotal} assets
      </Badge>
    );
  }
  if (sectionId === 'channels') {
    const ok = status.channelsReady > 0;
    return (
      <Badge
        variant="outline"
        className={cn(
          'text-[10px]',
          ok
            ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
            : 'text-slate-400 border-slate-700 bg-slate-800/50',
        )}
      >
        {status.channelsReady} / {status.channelsTotal} set
      </Badge>
    );
  }
  if (sectionId === 'social') {
    if (status.socialExpired > 0) {
      return (
        <Badge variant="outline" className="text-[10px] text-red-400 border-red-500/30 bg-red-500/10">
          {status.socialExpired} token expired
        </Badge>
      );
    }
    const ok = status.socialReady === status.socialTotal;
    return (
      <Badge
        variant="outline"
        className={cn(
          'text-[10px]',
          ok
            ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
            : status.socialReady > 0
              ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
              : 'text-slate-400 border-slate-700 bg-slate-800/50',
        )}
      >
        {status.socialReady} / {status.socialTotal} Connected
      </Badge>
    );
  }
  if (sectionId === 'team') {
    return (
      <Badge variant="outline" className="text-[10px] text-slate-300 border-slate-700 bg-slate-800/50">
        {status.teamCount} member{status.teamCount === 1 ? '' : 's'}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-slate-400 border-slate-700 bg-slate-800/50">
      Developer
    </Badge>
  );
}

export function SettingsHub({ showApiKeys }: { showApiKeys: boolean }) {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand } = useBrand();
  const [drawer, setDrawer] = useState<DrawerKey>(null);
  const [status, setStatus] = useState<HubStatus>(FALLBACK_STATUS);
  const [statusPending, setStatusPending] = useState(true);
  const [health, setHealth] = useState<HealthState>({ api: 'loading' });

  const loadStatus = useCallback(async () => {
    if (!isLoaded) return;
    setStatusPending(true);
    try {
      const token = await getToken();
      const [social, sources, connections, team, brands] = await Promise.all([
        listConnectedAccounts(token ?? undefined).catch(() => ({ accounts: [] as ConnectedAccount[] })),
        getSourceChannels(token ?? undefined).catch(() => ({ ok: false as const, sourceChannels: {} as import('@/lib/api').SourceChannels })),
        getChannelConnections(token ?? undefined).catch(() => ({ connections: [] as unknown[] })),
        apiFetch<{ members: unknown[] }>('/team', { token: token ?? undefined }).catch(() => ({ members: [] as unknown[] })),
        getBrands(token ?? undefined).catch(() => [] as import('@/lib/api').Brand[]),
      ]);

      const accounts = Array.isArray(social?.accounts) ? social.accounts : [];
      const expired = accounts.filter((a) => {
        if (!a?.tokenExpiry || a.hasRefreshToken) return false;
        const exp = new Date(a.tokenExpiry).getTime();
        return !Number.isNaN(exp) && exp < Date.now();
      }).length;

      const brandList = Array.isArray(brands) ? brands : [];
      const brand = brandList.find((b) => b.id === activeBrand?.id) ?? brandList[0] ?? activeBrand;
      const brandReady = [brand?.image_url, brand?.intro_card_url, brand?.outro_card_url]
        .filter(Boolean).length;

      const src = (sources?.sourceChannels ?? {}) as import('@/lib/api').SourceChannels;
      const channelVals = [src.twitchLogin, src.kickUsername, src.youtubeHandle].filter(Boolean).length;
      const oauth = Array.isArray(connections?.connections) ? connections.connections.length : 0;
      const members = Array.isArray(team?.members) ? team.members : [];

      setStatus({
        brandReady,
        brandTotal: 3,
        channelsReady: Math.max(channelVals, oauth > 0 ? Math.min(oauth, 3) : channelVals),
        channelsTotal: 3,
        socialReady: accounts.length,
        socialTotal: 3,
        socialExpired: expired,
        // At least the signed-in member — never leave team at "Checking…"
        teamCount: Math.max(1, members.length),
      });
    } catch {
      setStatus(FALLBACK_STATUS);
    } finally {
      setStatusPending(false);
    }
  }, [getToken, isLoaded, activeBrand]);

  const loadHealth = useCallback(async () => {
    setHealth((h) => ({ ...h, api: 'loading' }));
    try {
      const res = await fetch(`${API_BASE}/health`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'private, max-age=0' },
      });
      if (!res.ok) {
        setHealth({ api: 'down', checkedAt: new Date().toISOString() });
        return;
      }
      const data = await res.json().catch(() => ({}));
      setHealth({
        api: 'ok',
        apiVersion: typeof data?.version === 'string' ? data.version : undefined,
        checkedAt: new Date().toISOString(),
      });
    } catch {
      setHealth({ api: 'down', checkedAt: new Date().toISOString() });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadHealth();
    const id = setInterval(() => { void loadHealth(); }, 60_000);
    return () => clearInterval(id);
  }, [loadHealth]);

  const sections = SECTIONS.filter((s) => s.id !== 'api-keys' || showApiKeys);

  return (
    <PageShell maxWidth="6xl" className="!space-y-0 mx-auto py-8 px-1 sm:px-2">
      <PageHeader
        title="Settings"
        subtitle="Configuration hub — check integration health at a glance, manage details in-place."
      />

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sections.map((s) => {
          const isDrawer = !!s.drawer;
          const cardClass = cn(
            'group rounded-xl border border-slate-800 bg-slate-900 p-6 flex flex-col gap-3',
            'hover:border-amber-500/50 hover:bg-slate-900/80 transition-all cursor-pointer text-left w-full',
          );
          const body = (
            <>
              <div className="flex items-center justify-between gap-3 mb-1">
                <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
                  {s.icon}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {statusBadge(s.id, status, statusPending)}
                  {isDrawer && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wide text-slate-500 group-hover:text-amber-400 transition-colors">
                      Open
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  )}
                  {!isDrawer && (
                    <ChevronRight className="h-4 w-4 text-slate-600 group-hover:text-amber-400 transition-colors" aria-hidden />
                  )}
                </div>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">{s.title}</h3>
                <p className="text-sm text-slate-400 mt-1">{s.description}</p>
              </div>
            </>
          );

          if (s.href) {
            return (
              <Link key={s.id} href={s.href} className={cardClass}>
                {body}
              </Link>
            );
          }

          return (
            <button
              key={s.id}
              type="button"
              className={cardClass}
              onClick={() => setDrawer(s.drawer ?? null)}
            >
              {body}
            </button>
          );
        })}
      </div>

      <footer className="mt-10 rounded-xl border border-slate-800 bg-slate-900/80 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">System Status / API Health</p>
            <p className="text-xs text-slate-300 mt-1">
              Live check against AuraFlux API
              {health.apiVersion ? ` · v${health.apiVersion}` : ''}
              {health.checkedAt
                ? ` · checked ${new Date(health.checkedAt).toLocaleTimeString()}`
                : ''}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Badge
              variant="outline"
              className={cn(
                'text-[11px] h-8 px-3 inline-flex items-center',
                health.api === 'ok'
                  ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                  : health.api === 'loading'
                    ? 'text-slate-400 border-slate-700'
                    : 'text-red-400 border-red-500/30 bg-red-500/10',
              )}
            >
              {health.api === 'ok' ? 'API Healthy' : health.api === 'loading' ? 'Checking…' : 'API Unreachable'}
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 border-slate-700 text-slate-200 hover:bg-slate-800"
              onClick={() => { void loadHealth(); void loadStatus(); }}
            >
              Refresh
            </Button>
          </div>
        </div>
      </footer>

      <SettingsDrawers
        open={drawer}
        onOpenChange={setDrawer}
        onStatusChange={() => { void loadStatus(); }}
      />
    </PageShell>
  );
}
