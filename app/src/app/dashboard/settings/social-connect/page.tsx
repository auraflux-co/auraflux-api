'use client';
/**
 * /dashboard/settings/social-connect — Connect/disconnect YouTube, TikTok, Instagram (CPD-86)
 *
 * Displays connected accounts with OAuth connect buttons.
 * Connect flow: redirect to /social/connect/:platform → OAuth → callback → save tokens.
 */

import { useEffect, useState, useTransition } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  listConnectedAccounts,
  disconnectPlatform,
  getSocialConnectUrl,
  type ConnectedAccount,
  type SocialPlatform,
} from '@/lib/api';

const PLATFORMS: { id: SocialPlatform; label: string; color: string; hint: string }[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    color: 'bg-red-500',
    hint: 'Publish directly to YouTube. Available on all plans.',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    color: 'bg-black',
    hint: 'Publish directly to TikTok. Available on Managed plan.',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    color: 'bg-gradient-to-r from-purple-500 to-pink-500',
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
      window.history.replaceState({}, '', '/dashboard/settings/social-connect');
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
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">My Social Accounts</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Connect your publishing channels. AuraFlux will post directly without a third-party proxy.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {PLATFORMS.map((p) => {
          const connected = accountMap[p.id] as ConnectedAccount | undefined;
          const isDisc = disconnecting === p.id;

          return (
            <Card key={p.id}>
              <CardContent className="flex items-center gap-4 pt-5 pb-5">
                {/* Platform dot */}
                <div className={`w-10 h-10 rounded-full ${p.color} flex-shrink-0 flex items-center justify-center text-white text-xs font-bold`}>
                  {p.label[0]}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{p.label}</span>
                    {connected
                      ? <Badge variant="default" className="text-xs">Connected</Badge>
                      : <Badge variant="outline" className="text-xs">Not connected</Badge>}
                  </div>
                  {connected ? (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {connected.handle || connected.platformUserId || 'Account linked'}
                      {connected.tokenExpiry && (
                        <span> · expires {new Date(connected.tokenExpiry).toLocaleDateString()}</span>
                      )}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-0.5">{p.hint}</p>
                  )}
                </div>

                <div className="flex-shrink-0">
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

    </div>
  );
}
