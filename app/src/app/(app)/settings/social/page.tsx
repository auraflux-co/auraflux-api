'use client';
import { formatUserError } from '@/lib/job-labels';
/**
 * /settings/social — Connect/disconnect YouTube, TikTok, Instagram (CPD-86)
 *
 * Platform tiles lit up in their own brand colours when connected;
 * muted (opacity) when not — real logo always shown, never initials.
 */

import { useEffect, useState, useTransition } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Button } from '@/components/ui/button';
import { YouTubeIcon, TikTokIcon, InstagramIcon } from '@/components/icons/brand-icons';
import type { ReactNode } from 'react';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import {
  listConnectedAccounts,
  disconnectPlatform,
  getSocialConnectUrl,
  getActiveBrandId,
  type ConnectedAccount,
  type SocialPlatform,
} from '@/lib/api';
import { CheckCircle2 } from 'lucide-react';

interface PlatformDef {
  id: SocialPlatform;
  label: string;
  icon: ReactNode;
  hint: string;
  /** Tailwind classes applied to the card when CONNECTED */
  connectedCard: string;
  /** Tailwind classes applied to the icon wrapper when CONNECTED */
  connectedGlow: string;
  /** Tailwind classes applied to the icon wrapper when NOT connected */
  dimmedGlow: string;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    icon: <YouTubeIcon size={48} />,
    hint: 'Publish directly to YouTube. Available on all plans.',
    connectedCard: 'border-red-500/50 bg-red-500/5',
    connectedGlow: 'ring-2 ring-red-500/40 rounded-xl',
    dimmedGlow: 'opacity-40 grayscale rounded-xl',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    icon: <TikTokIcon size={48} />,
    hint: 'Publish directly to TikTok. Available on all plans.',
    connectedCard: 'border-zinc-300/30 bg-zinc-900/30 dark:border-zinc-300/20 dark:bg-zinc-900/40',
    connectedGlow: 'ring-2 ring-zinc-400/40 rounded-xl',
    dimmedGlow: 'opacity-40 grayscale rounded-xl',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    icon: <InstagramIcon size={48} />,
    hint: 'Publish directly to Instagram Reels. Available on all plans.',
    connectedCard: 'border-pink-500/50 bg-gradient-to-br from-yellow-500/5 via-pink-500/5 to-purple-600/5',
    connectedGlow: 'ring-2 ring-pink-500/40 rounded-xl',
    dimmedGlow: 'opacity-40 grayscale rounded-xl',
  },
];

export default function SocialConnectPage() {
  const { getToken } = useAuth();
  const [accounts, setAccounts]   = useState<ConnectedAccount[]>([]);
  const [isPending, start]        = useTransition();
  const [error, setError]         = useState<string | null>(null);
  const [disconnecting, setDisc]  = useState<SocialPlatform | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('social_connected');
    const errMsg    = params.get('social_error');
    const platform  = params.get('platform') as SocialPlatform | null;

    if (connected || errMsg) {
      window.history.replaceState({}, '', '/settings/social');

      if (window.opener && !window.opener.closed) {
        if (connected) {
          window.opener.postMessage({ type: 'social_connected', platform: connected }, window.location.origin);
        } else {
          window.opener.postMessage({ type: 'social_error', platform, error: errMsg }, window.location.origin);
        }
        window.close();
        return;
      }

      if (errMsg) setError(decodeURIComponent(errMsg));
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
        setError(e instanceof Error ? formatUserError(e.message) : 'Failed to load accounts');
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
    const token = await getToken();
    const url   = new URL(getSocialConnectUrl(platform));
    if (token) url.searchParams.set('token', token);
    // Always pass the active brand so the token is stored against the right brand,
    // not just the account's primary brand fallback.
    const activeBrandId = getActiveBrandId();
    if (activeBrandId) url.searchParams.set('brandId', activeBrandId);

    const popup = window.open(
      url.toString(),
      'auraflux_social_connect',
      'width=520,height=680,scrollbars=yes,resizable=yes,toolbar=no,menubar=no,location=no,status=no',
    );

    if (!popup) {
      window.location.href = url.toString();
      return;
    }

    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'social_connected') {
        window.removeEventListener('message', onMessage);
        setTimeout(fetchAccounts, 1000);
      } else if (e.data?.type === 'social_error') {
        window.removeEventListener('message', onMessage);
        const errText: string = e.data.error ?? 'Connection failed';
        if (errText.toLowerCase().includes('missing') || errText.toLowerCase().includes('verifier')) {
          setError('Reconnecting — please complete the connection again.');
          setTimeout(() => handleConnect(platform), 1500);
        } else {
          setError(decodeURIComponent(errText));
        }
        fetchAccounts();
      }
    }
    window.addEventListener('message', onMessage);

    const poll = setInterval(() => {
      if (popup.closed) {
        clearInterval(poll);
        window.removeEventListener('message', onMessage);
        fetchAccounts();
      }
    }, 800);
  }

  const accountMap = Object.fromEntries(accounts.map((a) => [a.platform, a]));

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="My Social Accounts"
        subtitle="Connect your publishing channels. AuraFlux posts directly — no third-party proxy."
      />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 af-body text-destructive mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {PLATFORMS.map((p) => {
          const connected = accountMap[p.id] as ConnectedAccount | undefined;
          const isDisc = disconnecting === p.id;
          const isConnected = !!connected;

          return (
            <div
              key={p.id}
              className={`
                relative rounded-2xl border p-5 flex flex-col items-center gap-4 transition-all
                ${isConnected
                  ? `${p.connectedCard} shadow-sm`
                  : 'border-border/60 bg-card'}
              `}
            >
              {/* Connected badge */}
              {isConnected && (
                <div className="absolute top-3 right-3">
                  <CheckCircle2 className="h-4 w-4 text-green-400" />
                </div>
              )}

              {/* Platform logo — full color when connected, dimmed when not */}
              <div className={isConnected ? p.connectedGlow : p.dimmedGlow}>
                {p.icon}
              </div>

              {/* Platform name + status */}
              <div className="text-center flex-1 w-full">
                <p className={`text-sm font-semibold ${isConnected ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {p.label}
                </p>
                {isConnected ? (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {connected.handle || connected.platformUserId || 'Account linked'}
                    {connected.tokenExpiry && !connected.hasRefreshToken && (
                      <>
                        {' '}·{' '}
                        {new Date(connected.tokenExpiry).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000
                          ? <span className="text-amber-400 font-medium">Reconnect soon</span>
                          : <span>expires {new Date(connected.tokenExpiry).toLocaleDateString()}</span>
                        }
                      </>
                    )}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground/60 mt-0.5">{p.hint}</p>
                )}
              </div>

              {/* Action button */}
              <div className="w-full">
                {isConnected ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => handleDisconnect(p.id)}
                    disabled={isDisc || isPending}
                  >
                    {isDisc ? 'Disconnecting…' : 'Disconnect'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => handleConnect(p.id)}
                    disabled={isPending}
                  >
                    Connect
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </PageShell>
  );
}
