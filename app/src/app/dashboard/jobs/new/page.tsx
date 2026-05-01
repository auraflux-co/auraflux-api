'use client';
/**
 * /dashboard/jobs/new — Job submission form (CPD-23)
 *
 * Handles all three entry types: fetch (URLs), upload (file keys), create (prompt).
 * Submits to POST /jobs via the AuraFlux API client.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createJob, type CreateJobPayload } from '@/lib/api';
import { SchedulePicker, type ScheduleValue } from '@/components/jobs/schedule-picker';
import { CONTENT_TYPES_ORDERED, labelForContentType } from '@/lib/content-types';

type EntryType = 'fetch' | 'upload' | 'create';

const PLATFORMS = ['youtube', 'tiktok', 'instagram'] as const;

export default function NewJobPage() {
  const router = useRouter();
  const { getToken } = useAuth();
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [entryType, setEntryType]       = useState<EntryType>('fetch');
  const [contentType, setContentType]   = useState<string>('news-long');
  const [platforms, setPlatforms]       = useState<string[]>(['youtube']);
  const [sourceUrls, setSourceUrls]     = useState('');
  const [promptText, setPromptText]     = useState('');
  const [fileKeys, setFileKeys]         = useState('');
  const [schedule, setSchedule]         = useState<ScheduleValue>({ publishMode: 'immediate' });

  function togglePlatform(p: string) {
    setPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload: CreateJobPayload = {
      contentType,
      entryType,
      platforms,
    };

    if (entryType === 'fetch') {
      const urls = sourceUrls.split('\n').map((u) => u.trim()).filter(Boolean);
      if (urls.length === 0) { setError('At least one source URL is required'); return; }
      payload.fetchSpec = { sourceUrls: urls };
    } else if (entryType === 'upload') {
      const keys = fileKeys.split('\n').map((k) => k.trim()).filter(Boolean);
      if (keys.length === 0) { setError('At least one storage key is required'); return; }
      payload.uploadSpec = { fileKeys: keys };
    } else {
      if (!promptText.trim()) { setError('Prompt text is required'); return; }
      payload.createSpec = { promptText: promptText.trim() };
    }

    if (platforms.length === 0) { setError('Select at least one platform'); return; }

    // Attach schedule
    payload.publishMode = schedule.publishMode;
    if (schedule.publishMode === 'scheduled') {
      if (!schedule.scheduledPublishAt) { setError('Select a publish date and time'); return; }
      payload.scheduledPublishAt = schedule.scheduledPublishAt;
    }

    start(async () => {
      try {
        const token = await getToken();
        const res = await createJob(payload, token ?? undefined);
        router.push(`/dashboard/jobs`);
        console.info('[new-job] created', res.jobId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to create job');
      }
    });
  }

  return (
    <div className="max-w-xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">New job</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Configure and submit a content production job</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Content type */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Content type</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {CONTENT_TYPES_ORDERED.map((ct) => (
                <button
                  key={ct} type="button"
                  onClick={() => setContentType(ct)}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-md border transition-colors',
                    contentType === ct
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {labelForContentType(ct)}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Platforms */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Platforms</CardTitle></CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {PLATFORMS.map((p) => (
                <button
                  key={p} type="button"
                  onClick={() => togglePlatform(p)}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-md border transition-colors capitalize',
                    platforms.includes(p)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Entry type */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Content source</CardTitle>
              <div className="flex gap-1">
                {(['fetch', 'upload', 'create'] as EntryType[]).map((et) => (
                  <button
                    key={et} type="button"
                    onClick={() => setEntryType(et)}
                    className={cn(
                      'px-2 py-1 text-xs rounded border transition-colors',
                      entryType === et
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {et}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {entryType === 'fetch' && (
              <div className="space-y-1">
                <Label className="text-xs">Source URLs <span className="text-muted-foreground">(one per line)</span></Label>
                <Textarea
                  value={sourceUrls}
                  onChange={(e) => setSourceUrls(e.target.value)}
                  placeholder="https://..."
                  className="min-h-[80px] text-sm font-mono"
                />
              </div>
            )}
            {entryType === 'upload' && (
              <div className="space-y-1">
                <Label className="text-xs">Storage keys <span className="text-muted-foreground">(one per line, from Upload API)</span></Label>
                <Textarea
                  value={fileKeys}
                  onChange={(e) => setFileKeys(e.target.value)}
                  placeholder="r2://bucket/video.mp4"
                  className="min-h-[80px] text-sm font-mono"
                />
              </div>
            )}
            {entryType === 'create' && (
              <div className="space-y-1">
                <Label className="text-xs">Prompt <span className="text-muted-foreground">(max 2000 chars)</span></Label>
                <Textarea
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  maxLength={2000}
                  placeholder="Describe the video you want to create…"
                  className="min-h-[100px] text-sm"
                />
                <p className="text-[10px] text-muted-foreground text-right">{promptText.length}/2000</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Schedule picker */}
        <SchedulePicker
          platforms={platforms}
          value={schedule}
          onChange={setSchedule}
        />

        <Separator />

        {error && (
          <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
        )}

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => router.back()}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending}
            className={cn(buttonVariants({ size: 'sm' }), isPending && 'opacity-60')}
          >
            {isPending ? 'Submitting…' : 'Submit job'}
          </button>
        </div>
      </form>
    </div>
  );
}
