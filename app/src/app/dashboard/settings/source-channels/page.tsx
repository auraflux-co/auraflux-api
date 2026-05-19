'use client';
/**
 * /dashboard/settings/source-channels — Default source channel handles (CPD-292)
 *
 * Saves Twitch, Kick, and YouTube channel usernames per customer so the
 * source library picker can pre-fill them instead of requiring manual entry
 * every time a job is created.
 */

import { useEffect, useState, useTransition } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { getSourceChannels, saveSourceChannels, type SourceChannels } from '@/lib/api';

const PLATFORMS = [
  {
    key: 'twitchLogin' as const,
    label: 'Twitch',
    placeholder: 'hasanabi',
    hint: 'Channel login name (lowercase, no @)',
    color: 'bg-purple-600',
  },
  {
    key: 'kickUsername' as const,
    label: 'Kick',
    placeholder: 'n3on',
    hint: 'Channel username (lowercase)',
    color: 'bg-green-500',
  },
  {
    key: 'youtubeHandle' as const,
    label: 'YouTube',
    placeholder: '@LazarBeam',
    hint: 'Channel handle starting with @',
    color: 'bg-red-500',
  },
];

export default function SourceChannelsPage() {
  const { getToken } = useAuth();
  const [channels, setChannels]   = useState<SourceChannels>({});
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [isPending, start]        = useTransition();

  useEffect(() => {
    start(async () => {
      try {
        const token = await getToken();
        const res   = await getSourceChannels(token ?? undefined);
        setChannels(res.sourceChannels ?? {});
      } catch {
        // non-blocking — page still usable with empty defaults
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleChange(key: keyof SourceChannels, value: string) {
    setSaved(false);
    setChannels((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    start(async () => {
      setError(null);
      setSaved(false);
      try {
        const token = await getToken();
        const res   = await saveSourceChannels(channels, token ?? undefined);
        setChannels(res.sourceChannels ?? channels);
        setSaved(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save');
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

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {PLATFORMS.map((p) => (
          <Card key={p.key}>
            <CardContent className="flex items-start gap-4 pt-5 pb-5">
              <div className={`w-10 h-10 rounded-full ${p.color} flex-shrink-0 flex items-center justify-center text-white text-xs font-bold mt-1`}>
                {p.label[0]}
              </div>

              <div className="flex-1 space-y-1.5">
                <Label htmlFor={p.key} className="text-sm font-medium">
                  {p.label}
                </Label>
                <Input
                  id={p.key}
                  placeholder={p.placeholder}
                  value={channels[p.key] ?? ''}
                  onChange={(e) => handleChange(p.key, e.target.value)}
                  className="h-9"
                  disabled={isPending}
                />
                <p className="text-xs text-muted-foreground">{p.hint}</p>
              </div>
            </CardContent>
          </Card>
        ))}
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
        These are used as defaults only. You can always browse a different channel when creating a job.
      </p>
    </div>
  );
}
