'use client';

/**
 * Sponsor marker scan — detect phrases, optional boundary nudge + lower-third.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { scanJobSponsors } from '@/lib/api';

type Marker = { startSec?: number; endSec?: number; phrase?: string; confidence?: number };
type Boundaries = {
  adjusted?: boolean;
  trimStart?: number;
  trimEnd?: number;
  reason?: string;
};

export function SponsorScanPanel({
  jobId,
  token,
  brandName,
}: {
  jobId: string;
  token: string;
  brandName?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [boundaries, setBoundaries] = useState<Boundaries | null>(null);
  const [applied, setApplied] = useState(false);
  const [overlayOn, setOverlayOn] = useState(false);

  async function runScan(opts: { appendSponsorOverlay?: boolean; applyBoundaries?: boolean }) {
    setBusy(opts.applyBoundaries ? 'Applying boundary adjust…' : 'Scanning transcript…');
    setError(null);
    try {
      const res = await scanJobSponsors(
        jobId,
        {
          appendSponsorOverlay: opts.appendSponsorOverlay ?? overlayOn,
          applyBoundaries: opts.applyBoundaries ?? false,
          brandName,
        },
        token,
      );
      setMarkers((res.markers as Marker[]) || []);
      setBoundaries((res.boundaries as Boundaries) || null);
      setApplied(!!(res as { applied?: boolean }).applied);
      if (opts.appendSponsorOverlay) setOverlayOn(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sponsor scan failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div>
        <p className="text-sm font-medium">Sponsor markers</p>
        <p className="af-caption text-muted-foreground">
          Scan the job transcript for sponsor reads, nudge the peak trim, optionally append a lower-third.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => runScan({})}>
          Scan transcript
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!!busy || !boundaries?.adjusted}
          onClick={() => runScan({ applyBoundaries: true })}
        >
          Apply boundary adjust
        </Button>
        <label className="flex items-center gap-2 text-sm px-1">
          <input
            type="checkbox"
            checked={overlayOn}
            disabled={!!busy}
            onChange={async (e) => {
              const next = e.target.checked;
              setOverlayOn(next);
              await runScan({ appendSponsorOverlay: next });
            }}
          />
          Append Sponsor Overlay
        </label>
      </div>
      {markers.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {markers.map((m, i) => (
            <li key={`${m.phrase}-${i}`} className="af-caption">
              {m.startSec != null ? `${Math.round(m.startSec)}s` : '?'}
              {m.endSec != null ? `–${Math.round(m.endSec)}s` : ''}
              {' · '}
              <span className="text-foreground">{m.phrase || 'marker'}</span>
            </li>
          ))}
        </ul>
      ) : (
        !busy && <p className="af-caption text-muted-foreground">No markers yet — run scan after the video has a transcript.</p>
      )}
      {boundaries?.adjusted && (
        <p className="af-caption text-amber-700 dark:text-amber-400">
          Suggested trim: {boundaries.trimStart}s–{boundaries.trimEnd}s
          {boundaries.reason ? ` (${boundaries.reason})` : ''}
          {applied ? ' · applied to job peak window' : ' · not applied yet'}
        </p>
      )}
      {busy && <p className="af-caption text-muted-foreground">{busy}</p>}
      {error && <p className="af-caption text-destructive">{error}</p>}
    </div>
  );
}
