'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { createReviewShareLink } from '@/lib/api';

export function GenerateReviewLinkButton({
  jobId,
  token,
}: {
  jobId: string;
  token: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onGenerate() {
    setBusy(true);
    setError(null);
    try {
      const res = await createReviewShareLink(jobId, token, 7);
      setUrl(res.url);
      try {
        await navigator.clipboard.writeText(res.url);
      } catch { /* ignore */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onGenerate}>
        {busy ? 'Creating…' : 'Generate Review Link'}
      </Button>
      {url && (
        <p className="af-caption text-muted-foreground break-all">
          Copied: <a className="underline" href={url} target="_blank" rel="noreferrer">{url}</a>
        </p>
      )}
      {error && <p className="af-caption text-destructive">{error}</p>}
    </div>
  );
}
