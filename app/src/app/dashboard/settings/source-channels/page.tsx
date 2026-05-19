'use client';
/**
 * /dashboard/settings/source-channels — Default source channel handles (CPD-292)
 *
 * Saves Twitch, Kick, and YouTube channel usernames per customer so the
 * source library picker can pre-fill them. Verifies each channel as the
 * user types (500ms debounce) and shows the channel avatar + display name.
 */

import { useEffect, useRef, useState, useTransition, useCallback } from 'react';
import Image from 'next/image';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  getSourceChannels,
  saveSourceChannels,
  resolveSourceChannel,
  type SourceChannels,
  type SourcePlatform,
  type ResolvedChannel,
} from '@/lib/api';

const PLATFORMS: {
  key:    keyof SourceChannels;
  platform: SourcePlatform;
  label:  string;
  placeholder: string;
  hint:   string;
  color:  string;
}[] = [
  {
    key: 'twitchLogin', platform: 'twitch',
    label: 'Twitch', placeholder: 'hasanabi',
    hint: 'Channel login name (lowercase, no @)',
    color: 'bg-purple-600',
  },
  {
    key: 'kickUsername', platform: 'kick',
    label: 'Kick', placeholder: 'n3on',
    hint: 'Channel username (lowercase)',
    color: 'bg-green-500',
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

export default function SourceChannelsPage() {
  const { getToken } = useAuth();
  const [channels, setChannels]   = useState<SourceChannels>({});
  const [saved, setSaved]         = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isPending, start]        = useTransition();

  const [verify, setVerify] = useState<Record<string, ChannelVerification>>({
    twitchLogin:   { state: 'idle', channel: null, error: null },
    kickUsername:  { state: 'idle', channel: null, error: null },
    youtubeHandle: { state: 'idle', channel: null, error: null },
  });

  const debounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Load saved channels on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const res   = await getSourceChannels(token ?? undefined);
        if (cancelled) return;
        const sc = res.sourceChannels ?? {};
        setChannels(sc);
        // Pre-verify any already-saved values
        for (const p of PLATFORMS) {
          const val = sc[p.key];
          if (val) scheduleVerify(p.key, p.platform, val, token ?? undefined);
        }
      } catch { /* non-blocking */ }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Source Channels</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Save your default source channels. The source library picker will pre-fill these
          so you don&apos;t have to type them every time.
        </p>
      </div>

      {saveError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {saveError}
        </div>
      )}

      <div className="space-y-4">
        {PLATFORMS.map((p) => {
          const v = verify[p.key];
          const avatar = v.channel?.avatarUrl ?? v.channel?.thumbnailUrl ?? null;
          const displayName = v.channel?.displayName ?? v.channel?.title ?? null;

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

                <div className="flex-1 space-y-1.5">
                  <Label htmlFor={p.key} className="text-sm font-medium">
                    {p.label}
                  </Label>

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
                    {/* Inline status indicator */}
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

                  {/* Channel name preview when verified */}
                  {v.state === 'ok' && displayName && (
                    <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                      {displayName}
                    </p>
                  )}
                  {v.state === 'error' && (
                    <p className="text-xs text-destructive">
                      {v.error ?? 'Channel not found'}
                    </p>
                  )}
                  {v.state === 'idle' && (
                    <p className="text-xs text-muted-foreground">{p.hint}</p>
                  )}
                  {v.state === 'loading' && (
                    <p className="text-xs text-muted-foreground">Verifying…</p>
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
          <span className="text-sm text-green-600 dark:text-green-400">
            Saved
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        These are defaults only. You can still browse a different channel when creating a job.
      </p>
    </div>
  );
}
