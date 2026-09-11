'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { getPlaylistStrategyMatch } from '@/lib/api';

export function PlaylistStrategyBadge({
  jobId,
  token,
  onMatch,
}: {
  jobId: string;
  token: string;
  onMatch?: (m: { playlistId: string | null; playlistTitle: string | null }) => void;
}) {
  const [badge, setBadge] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getPlaylistStrategyMatch(jobId, token, 'youtube');
        if (cancelled || res.gated || !res.matched) return;
        setBadge(res.badge || 'Auto-matched by strategy rule');
        setTitle(res.playlistTitle || res.playlistId || null);
        onMatch?.({ playlistId: res.playlistId || null, playlistTitle: res.playlistTitle || null });
      } catch { /* optional */ }
    })();
    return () => { cancelled = true; };
  }, [jobId, token, onMatch]);

  if (!badge) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">{badge}</Badge>
      {title && <span className="af-caption text-muted-foreground">→ {title}</span>}
    </div>
  );
}
