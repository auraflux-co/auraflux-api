'use client';
/**
 * /settings/channels — Source channel setup (CPD-292, CPD-353)
 *
 * Two connection modes per platform:
 *   1. OAuth (preferred) — one-click, auto-fills username, uses Kick public API directly.
 *   2. Username entry   — manual fallback.
 */

import { useEffect, useRef, useState, useTransition, useCallback } from 'react';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { formatUserError } from '@/lib/job-labels';
import {
  getSourceChannels,
  saveSourceChannels,
  resolveSourceChannel,
  type SourceChannels,
  type SourcePlatform,
  type ResolvedChannel,
} from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SourceConnection {
  platform: string;
  handle: string | null;
  platformUserId: string | null;
  connectedAt: string | null;
}

// ── Platform config ──────────────────────────────────────────────────────────

const PLATFORMS: {
  key:         keyof SourceChannels;
  platform:    SourcePlatform;
  label:       string;
  placeholder: string;
  hint:        string;
  color:       string;
  oauthPlatform?: string; // backend platform key for /channels/connect/:platform
}[] = [
  {
    key: 'twitchLogin', platform: 'twitch',
    label: 'Twitch', placeholder: 'hasanabi',
    hint: 'Channel login name (lowercase, no @)',
    color: 'bg-purple-600',
    // oauthPlatform: 'twitch', // CPD-353b — enable once TWITCH_CLIENT_SECRET is set
  },
  {
    key: 'kickUsername', platform: 'kick',
    label: 'Kick', placeholder: 'n3on',
    hint: 'Channel username (lowercase)',
    color: 'bg-green-500',
    oauthPlatform: 'kick',
  },
  {
    key: 'youtubeHandle', platform: 'youtube',
    label: 'YouTube', placeholder: '@LazarBeam',
    hint: 'Channel handle starting with @',
    color: 'bg-red-500',
  },
];

type VerifyState = 'idle' | 'loading' | 'ok' | 'error';

interface ChannelVerification {
  state:   VerifyState;
  channel: ResolvedChannel | null;
  error:   string | null;
}

const DEBOUNCE_MS = 500;
const API_BASE    = process.env.NEXT_PUBLIC_API_BASE || 'https://auraflux-api.onrender.com';

export default function SourceChannelsPage() {
  const { getToken }  = useAuth();
  const searchParams  = useSearchParams();

  const [channels, setChannels]   = useState<SourceChannels>({});
  const [saved, setSaved]         = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isPending, start]        = useTransition();

  const [connections, setConnections] = useState<Record<string, SourceConnection>>({});
  const [oauthError, setOauthError]   = useState<string | null>(null);
  const [oauthSuccess, setOauthSuccess] = useState<string | null>(null);

  const [verify, setVerify] = useState<Record<string, ChannelVerification>>({
    twitchLogin:   { state: 'idle', channel: null, error: null },
    kickUsername:  { state: 'idle', channel: null, error: null },
    youtubeHandle: { state: 'idle', channel: null, error: null },
  });

  const debounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Handle OAuth callback query params
  useEffect(() => {
    const connected = searchParams.get('channel_connected');
    const handle    = searchParams.get('handle');
    const errMsg    = searchParams.get('channel_error');
    const PLATFORM_LABELS: Record<string, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', twitch: 'Twitch', kick: 'Kick' };
    if (connected) setOauthSuccess(`${PLATFORM_LABELS[connected] ?? (connected.charAt(0).toUpperCase() + connected.slice(1))} connected${handle ? ` as @${handle}` : ''} successfully.`);
    if (errMsg)    setOauthError(decodeURIComponent(errMsg));
  }, [searchParams]);

  // Load connected OAuth source channels
  const loadConnections = useCallback(async () => {
    try {
      const token = await getToken();
      const res   = await fetch(`${API_BASE}/channels/connections`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const map: Record<string, SourceConnection> = {};
      for (const c of data.connections ?? []) map[c.platform] = c;
      setConnections(map);
    } catch { /* non-blocking */ }
  }, [getToken]);

  // Load saved channels on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const [res] = await Promise.all([
          getSourceChannels(token ?? undefined),
          loadConnections(),
        ]);
        if (cancelled) return;
        const sc = res.sourceChannels ?? {};
        setChannels(sc);
        for (const p of PLATFORMS) {
          const val = sc[p.key];
          if (val) scheduleVerify(p.key, p.platform, val, token ?? undefined);
        }
      } catch { /* non-blocking */ }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleConnect(oauthPlatform: string) {
    try {
      const token = await getToken();
      window.location.href = `${API_BASE}/channels/connect/${oauthPlatform}?token=${token}`;
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : 'Failed to start OAuth');
    }
  }

  async function handleDisconnect(oauthPlatform: string) {
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/channels/connections/${oauthPlatform}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      setConnections((prev) => {
        const next = { ...prev };
        delete next[oauthPlatform];
        return next;
      });
      setOauthSuccess(`${oauthPlatform} disconnected.`);
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : 'Failed to disconnect');
    }
  }

  const scheduleVerify = useCallback((
    key: string,
    platform: SourcePlatform,
    value: string,
    token?: string,
  ) => {
    clearTimeout(debounceRefs.current[key]);
    if (!value.trim()) {
      setVerify((prev) => ({ ...prev, [key]: { state: 'idle', channel: null, error: null } }));
      return;
    }
    setVerify((prev) => ({ ...prev, [key]: { state: 'loading', channel: null, error: null } }));
    debounceRefs.current[key] = setTimeout(async () => {
      try {
        const t   = token ?? (await getToken()) ?? undefined;
        const res = await resolveSourceChannel(platform, value.trim(), t);
        setVerify((prev) => ({
          ...prev,
          [key]: { state: 'ok', channel: res.channel, error: null },
        }));
      } catch (e) {
        setVerify((prev) => ({
          ...prev,
          [key]: {
            state: 'error',
            channel: null,
            error: e instanceof Error ? e.message : 'Channel not found',
          },
        }));
      }
    }, DEBOUNCE_MS);
  }, [getToken]);

  function handleChange(key: keyof SourceChannels, platform: SourcePlatform, value: string) {
    setSaved(false);
    setChannels((prev) => ({ ...prev, [key]: value }));
    scheduleVerify(key, platform, value);
  }

  function handleSave() {
    start(async () => {
      setSaveError(null);
      setSaved(false);
      try {
        const token = await getToken();
        const res   = await saveSourceChannels(channels, token ?? undefined);
        setChannels(res.sourceChannels ?? channels);
        setSaved(true);
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : 'Failed to save');
      }
    });
  }

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="My Channels"
        subtitle="Connect your source channels. The source library picker will pre-fill these so you don't have to type them every time."
      />

      {oauthError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 af-body text-destructive">
          {oauthError}
        </div>
      )}
      {oauthSuccess && (
        <div className="rounded-md border border-green-500/50 bg-green-500/10 px-4 py-3 af-body text-green-700 dark:text-green-400">
          {oauthSuccess}
        </div>
      )}
      {saveError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 af-body text-destructive">
          {formatUserError(saveError)}
        </div>
      )}

      <div className="space-y-4">
        {PLATFORMS.map((p) => {
          const v = verify[p.key];
          const avatar = v.channel?.avatarUrl ?? v.channel?.thumbnailUrl ?? null;
          const displayName = v.channel?.displayName ?? v.channel?.title ?? null;
          const oauthConn = p.oauthPlatform ? connections[p.oauthPlatform] : null;
          const isOauthConnected = !!oauthConn;

          return (
            <Card key={p.key}>
              <CardContent className="flex items-start gap-4 pt-5 pb-5">
                {/* Platform icon or verified avatar */}
                <div className="flex-shrink-0 mt-1">
                  {v.state === 'ok' && avatar ? (
                    <Image
                      src={avatar}
                      alt={displayName ?? p.label}
                      width={40}
                      height={40}
                      className="w-10 h-10 rounded-full object-cover ring-2 ring-green-500"
                      unoptimized
                    />
                  ) : (
                    <div className={`w-10 h-10 rounded-full ${p.color} flex items-center justify-center text-white text-xs font-bold`}>
                      {p.label[0]}
                    </div>
                  )}
                </div>

                <div className="flex-1 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor={p.key} className="af-label font-medium">
                      {p.label}
                    </Label>
                    {/* OAuth connect/disconnect button (Kick only for now) */}
                    {p.oauthPlatform && (
                      isOauthConnected ? (
                        <div className="flex items-center gap-2">
                          <span className="af-caption text-green-600 dark:text-green-400 font-medium">
                            ✓ Connected{oauthConn.handle ? ` as @${oauthConn.handle}` : ''}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                            onClick={() => handleDisconnect(p.oauthPlatform!)}
                          >
                            Disconnect
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleConnect(p.oauthPlatform!)}
                        >
                          Connect with {p.label}
                        </Button>
                      )
                    )}
                  </div>

                  {/* Username input — hidden when OAuth is connected (auto-filled) */}
                  {!isOauthConnected && (
                    <>
                      <div className="relative">
                        <Input
                          id={p.key}
                          placeholder={p.placeholder}
                          value={channels[p.key] ?? ''}
                          onChange={(e) => handleChange(p.key, p.platform, e.target.value)}
                          className={[
                            'h-9 pr-8',
                            v.state === 'ok'    ? 'border-green-500 focus-visible:ring-green-500' : '',
                            v.state === 'error' ? 'border-destructive focus-visible:ring-destructive' : '',
                          ].join(' ')}
                          disabled={isPending}
                        />
                        {v.state === 'loading' && (
                          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin text-xs">⟳</span>
                        )}
                        {v.state === 'ok' && (
                          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-green-500 text-xs font-bold">✓</span>
                        )}
                        {v.state === 'error' && (
                          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-destructive text-xs font-bold">✗</span>
                        )}
                      </div>

                      {v.state === 'ok' && displayName && (
                        <p className="af-caption text-success font-medium">{displayName}</p>
                      )}
                      {v.state === 'error' && (
                        <p className="af-caption text-destructive">{v.error ?? 'Channel not found'}</p>
                      )}
                      {v.state === 'idle' && (
                        <p className="af-caption">{p.hint}{p.oauthPlatform ? ' — or use Connect above for a better experience.' : ''}</p>
                      )}
                      {v.state === 'loading' && (
                        <p className="af-caption">Verifying…</p>
                      )}
                    </>
                  )}

                  {isOauthConnected && (
                    <p className="af-caption text-muted-foreground">
                      Connected via OAuth — source library will use your account directly.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Separator />

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save channels'}
        </Button>
        {saved && (
          <span className="af-label text-success">Saved</span>
        )}
      </div>

      <p className="af-caption">
        These are defaults only. You can still browse a different channel when creating a job.
      </p>
    </PageShell>
  );
}
