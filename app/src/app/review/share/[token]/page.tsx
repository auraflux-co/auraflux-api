'use client';

/**
 * Public guest review — /review/share/[token]
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  getPublicReviewShare,
  publicReviewApprove,
  publicReviewRevise,
  publicReviewComment,
} from '@/lib/api';

export default function GuestReviewSharePage() {
  const params = useParams();
  const token = String(params?.token || '');
  const [data, setData] = useState<Awaited<ReturnType<typeof getPublicReviewShare>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [showCaptions, setShowCaptions] = useState(true);
  const [showBed, setShowBed] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    getPublicReviewShare(token)
      .then((d) => {
        setData(d);
        setShowCaptions(d.captionsEnabled !== false);
        setShowBed(!!d.audioBed);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Invalid link'));
  }, [token]);

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-950 text-neutral-100">
        <p>{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-950 text-neutral-100">
        <p>Loading review…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-6 max-w-3xl mx-auto space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-400">Guest review</p>
        <h1 className="text-2xl font-semibold">{data.title}</h1>
      </header>

      {data.videoUrl ? (
        <video
          src={data.videoUrl}
          controls
          playsInline
          poster={data.thumbnailUrl || undefined}
          className="w-full rounded-xl bg-black aspect-[9/16] max-h-[70vh] object-contain"
        />
      ) : (
        <p className="text-neutral-400">Video not ready yet.</p>
      )}

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={showCaptions} onChange={(e) => setShowCaptions(e.target.checked)} />
          Captions preference
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={showBed} onChange={(e) => setShowBed(e.target.checked)} />
          Audio bed preference{data.audioBed ? ` (${data.audioBed})` : ''}
        </label>
      </div>
      <p className="text-xs text-neutral-500">
        Toggles record guest preference with Approve / Re-cut (full re-render happens in pipeline).
      </p>

      <div className="space-y-2">
        <Label className="text-neutral-200">Comment</Label>
        <textarea
          className="w-full min-h-[88px] rounded-md border border-neutral-700 bg-neutral-900 p-3 text-sm"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Notes for the editor…"
        />
        <Button
          type="button"
          variant="outline"
          disabled={!!busy || !comment.trim()}
          onClick={async () => {
            setBusy('Sending…');
            try {
              await publicReviewComment(token, comment.trim());
              setDone('Comment saved');
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Comment failed');
            } finally {
              setBusy(null);
            }
          }}
        >
          Leave comment
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          disabled={!!busy || data.permissions?.approve === false}
          onClick={async () => {
            setBusy('Approving…');
            setError(null);
            try {
              const res = await publicReviewApprove(token, {
                captions: showCaptions,
                audioBed: showBed,
                comment: comment.trim() || undefined,
              });
              if (res.accepted || res.ok) {
                setDone(res.status === 'publishing'
                  ? 'Approved — publish queued'
                  : 'Approved for publish');
              } else {
                setError(res.message || res.error || 'Approve failed');
              }
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Approve failed');
            } finally {
              setBusy(null);
            }
          }}
        >
          Approve & publish
        </Button>
        <Button
          variant="secondary"
          disabled={!!busy || data.permissions?.revise === false}
          onClick={async () => {
            setBusy('Requesting re-cut…');
            try {
              await publicReviewRevise(token, {
                comment: [
                  comment.trim(),
                  `captions=${showCaptions}`,
                  `audioBed=${showBed}`,
                ].filter(Boolean).join(' · '),
                categories: ['guest_recut'],
              });
              setDone('Re-cut requested');
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Revise failed');
            } finally {
              setBusy(null);
            }
          }}
        >
          Request Re-cut
        </Button>
      </div>

      {busy && <p className="text-sm text-neutral-400">{busy}</p>}
      {done && <p className="text-sm text-emerald-400">{done}</p>}
    </main>
  );
}
