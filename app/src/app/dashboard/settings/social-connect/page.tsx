'use client';
/**
 * /dashboard/settings/social-connect — Connect/disconnect YouTube, TikTok, Instagram (CPD-86)
 *
 * Displays connected accounts with OAuth connect buttons.
 * Connect flow: redirect to /social/connect/:platform → OAuth → callback → save tokens.
 */

import { useEffect, useState, useTransition } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
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
    hint: 'Available on all plans. Direct upload via YouTube Data API v3.',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    color: 'bg-black',
    hint: 'Requires Managed plan. TikTok Content Posting API.',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    color: 'bg-gradient-to-r from-purple-500 to-pink-500',
    hint: 'Requires Managed plan. Instagram Graph API — Reels.',
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

  function handleConnect(platform: SocialPlatform) {
    window.location.href = getSocialConnectUrl(platform);
  }

  const accountMap = Object.fromEntries(accounts.map((a) => [a.platform, a]));

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">My Social Accounts</h2>
        <p className="text-sm text-muted-foreground mt-1">
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

      <Separator />

      <div className="text-xs text-muted-foreground space-y-1">
        <p><strong>Platform audit status:</strong> Direct publishing requires platform approval before public posts.</p>
        <p>YouTube: Google OAuth compliance audit (1–4 weeks) · TikTok: App audit (5–10 days) · Instagram: Meta App Review (2–4 weeks)</p>
        <p>Until approved, posts use <code>privacyStatus: private</code> / <code>privacy_level: SELF_ONLY</code>.</p>
      </div>
    </div>
  );
}
