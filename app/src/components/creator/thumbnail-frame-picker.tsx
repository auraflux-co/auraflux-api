'use client';

/**
 * Thumbnail Frame Picker — 3 peak candidates + optional headline overlay.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  getThumbnailCandidates,
  approveThumbnail,
  previewThumbnailOverlay,
  type ThumbnailCandidate,
} from '@/lib/api';

export function ThumbnailFramePicker({
  jobId,
  token,
  topic,
}: {
  jobId: string;
  token: string;
  topic?: string;
}) {
  const [candidates, setCandidates] = useState<ThumbnailCandidate[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [overlayOn, setOverlayOn] = useState(false);
  const [hookText, setHookText] = useState(topic || '');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getThumbnailCandidates(jobId, token);
        if (cancelled) return;
        setCandidates((res.candidates || []).slice(0, 3));
        if (res.status === 'approved') setApproved(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'No candidates yet');
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, token]);

  async function onSelect(c: ThumbnailCandidate) {
    setSelected(c.index);
    setPreviewUrl(c.url);
    setBusy('Setting cover…');
    setError(null);
    try {
      await approveThumbnail(jobId, { method: c.method || 'frame', candidateIndex: c.index, r2Url: c.url }, token);
      setApproved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setBusy(null);
    }
  }

  async function onToggleOverlay(next: boolean) {
    setOverlayOn(next);
    if (selected == null) return;
    setBusy('Preview overlay…');
    try {
      const res = await previewThumbnailOverlay(jobId, {
        candidateIndex: selected,
        hookText,
        enabled: next,
      }, token);
      if (res.url) setPreviewUrl(res.url);
      else if (!next) {
        const c = candidates.find((x) => x.index === selected);
        if (c?.url) setPreviewUrl(c.url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Overlay preview failed');
    } finally {
      setBusy(null);
    }
  }

  if (error && !candidates.length) {
    return (
      <div className="rounded-lg border border-border p-4 space-y-1">
        <p className="text-sm font-medium">Thumbnail Frame Picker</p>
        <p className="af-caption text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (!candidates.length) return null;

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div>
        <p className="text-sm font-medium">Thumbnail Frame Picker</p>
        <p className="af-caption text-muted-foreground">
          3 peak-aware frames — click one to set the Shorts/Reels/TikTok cover.
          {approved ? ' Cover set.' : ''}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {candidates.map((c) => (
          <button
            key={c.index}
            type="button"
            onClick={() => onSelect(c)}
            className={`relative rounded-md overflow-hidden border-2 ${selected === c.index ? 'border-primary' : 'border-transparent'}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.url} alt={`Frame ${c.index}`} className="w-full aspect-video object-cover" />
            <span className="absolute bottom-1 left-1 text-[10px] bg-black/70 text-white px-1 rounded">
              {c.method || 'frame'} · {Math.round(c.offsetSeconds)}s
            </span>
          </button>
        ))}
      </div>
      {previewUrl && overlayOn && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt="Overlay preview" className="w-full max-w-sm rounded-md border" />
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={overlayOn}
            onChange={(e) => onToggleOverlay(e.target.checked)}
          />
          Headline overlay preview
        </label>
        {overlayOn && (
          <div className="flex-1 min-w-[160px] space-y-1">
            <Label>Headline</Label>
            <Input value={hookText} onChange={(e) => setHookText(e.target.value)} />
            <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => onToggleOverlay(true)}>
              Refresh preview
            </Button>
          </div>
        )}
      </div>
      {busy && <p className="af-caption text-muted-foreground">{busy}</p>}
      {error && <p className="af-caption text-destructive">{error}</p>}
    </div>
  );
}
