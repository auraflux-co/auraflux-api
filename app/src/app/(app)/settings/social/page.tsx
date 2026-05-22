'use client';
/**
 * /settings/social — Connect/disconnect YouTube, TikTok, Instagram (CPD-86)
 *
 * Displays connected accounts with OAuth connect buttons.
 * Connect flow: redirect to /social/connect/:platform → OAuth → callback → save tokens.
 */

import { useEffect, useState, useTransition } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { YouTubeIcon, TikTokIcon, InstagramIcon } from '@/components/icons/brand-icons';
import type { ReactNode } from 'react';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import {
  listConnectedAccounts,
  disconnectPlatform,
  getSocialConnectUrl,
  type ConnectedAccount,
  type SocialPlatform,
} from '@/lib/api';

const PLATFORMS: { id: SocialPlatform; label: string; icon: ReactNode; hint: string }[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    icon: <YouTubeIcon size={40} />,
    hint: 'Publish directly to YouTube. Available on all plans.',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    icon: <TikTokIcon size={40} />,
    hint: 'Publish directly to TikTok. Available on all plans.',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    icon: <InstagramIcon size={40} />,
    hint: 'Publish directly to Instagram Reels. Available on all plans.',
  },
];

export default function SocialConnectPage() {
  const { getToken } = useAuth();
  const [accounts, setAccounts]   = useState<ConnectedAccount[]>([]);
  const [isPending, start]        = useTransition();
  const [error, setError]         = useState<string | null>(null);
  const [disconnecting, setDisc]  = useState<SocialPlatform | null>(null);

  // Check for callback query params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('social_connected');
    const errMsg    = params.get('social_error');
    if (errMsg) setError(decodeURIComponent(errMsg));
    if (connected || errMsg) {
      // Remove query params from URL without reload
      window.history.replaceState({}, '', '/settings/social');
    }
    fetchAccounts();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function fetchAccounts() {
    start(async () => {
      try {
        const token = await getToken();
        const res = await listConnectedAccounts(token ?? undefined);
        setAccounts(res.accounts ?? []);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load accounts');
      }
    });
  }

  async function handleDisconnect(platform: SocialPlatform) {
    setDisc(platform);
    try {
      const token = await getToken();
      await disconnectPlatform(platform, token ?? undefined);
      setAccounts((prev) => prev.filter((a) => a.platform !== platform));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disconnect failed');
    } finally {
      setDisc(null);
    }
  }

  async function handleConnect(platform: SocialPlatform) {
    // The connect route is on the API domain — a plain browser redirect can't
    // send an Authorization header cross-origin. Pass the Clerk JWT as a query
    // param so the backend can verify it without a session cookie.
    const token = await getToken();
    const url   = new URL(getSocialConnectUrl(platform));
    if (token) url.searchParams.set('token', token);
    window.location.href = url.toString();
  }

  const accountMap = Object.fromEntries(accounts.map((a) => [a.platform, a]));

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="My Social Accounts"
        subtitle="Connect your publishing channels. AuraFlux will post directly without a third-party proxy."
      />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 af-body text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {PLATFORMS.map((p) => {
          const connected = accountMap[p.id] as ConnectedAccount | undefined;
          const isDisc = disconnecting === p.id;

          return (
            <Card key={p.id} className={connected ? 'border-success/40 bg-success/5' : ''}>
              <CardContent className="flex items-center gap-4 py-4 px-5">
                {/* Platform icon */}
                <div className="shrink-0 rounded-xl overflow-hidden">
                  {p.icon}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="af-h3">{p.label}</span>
                    {connected ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full af-caption font-medium bg-success/20 text-success border border-success/30">
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="4"/></svg>
                        Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full af-caption font-medium text-muted-foreground border border-border">
                        Not connected
                      </span>
                    )}
                  </div>
                  {connected ? (
                    <p className="af-label mt-0.5">
                      {connected.handle || connected.platformUserId || 'Account linked'}
                      {connected.tokenExpiry && (
                        <span> · expires {new Date(connected.tokenExpiry).toLocaleDateString()}</span>
                      )}
                    </p>
                  ) : (
                    <p className="af-label mt-0.5">{p.hint}</p>
                  )}
                </div>

                <div className="shrink-0">
                  {connected ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDisconnect(p.id)}
                      disabled={isDisc}
                    >
                      {isDisc ? 'Disconnecting…' : 'Disconnect'}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleConnect(p.id)}
                      disabled={isPending}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

    </PageShell>
  );
}
