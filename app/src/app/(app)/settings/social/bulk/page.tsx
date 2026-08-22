'use client';
/**
 * /settings/social/bulk — YouTube bulk channel → brand mapping (CPD-866)
 *
 * After the operator completes the YouTube OAuth via /social/connect/youtube/bulk,
 * the backend redirects here with ?session=<token>. This page:
 *   1. Fetches the channel list + all brands from GET /social/bulk/session/:token
 *   2. Renders a table: each YouTube channel gets a brand dropdown
 *   3. POSTs the mappings to /social/bulk/save on save
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/clerk-compat';
import { Button } from '@/components/ui/button';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { YouTubeIcon } from '@/components/icons/brand-icons';
import {
  getBulkSession,
  saveBulkMapping,
  type BulkChannel,
  type BulkBrand,
} from '@/lib/api';
import { CheckCircle2, Loader2 } from 'lucide-react';

export default function BulkSocialPage() {
  const { getToken } = useAuth();
  const router       = useRouter();
  const params       = useSearchParams();
  const sessionToken = params.get('session') ?? '';

  const [loading, setLoading]   = useState(true);
  const [saving,  setSaving]    = useState(false);
  const [error,   setError]     = useState<string | null>(null);
  const [done,    setDone]      = useState(false);

  const [channels, setChannels] = useState<BulkChannel[]>([]);
  const [brands,   setBrands]   = useState<BulkBrand[]>([]);

  // mapping: channelId → brandId ('' means skip)
  const [mapping, setMapping]   = useState<Record<string, string>>({});

  useEffect(() => {
    if (!sessionToken) {
      setError('No session token — please start the connect flow again.');
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const token = await getToken();
        const data  = await getBulkSession(sessionToken, token ?? undefined);
        setChannels(data.channels);
        setBrands(data.brands);
        // Pre-select: if a brand name matches a channel name exactly, pre-map it
        const initial: Record<string, string> = {};
        data.channels.forEach((ch) => {
          const match = data.brands.find(
            (b) => b.name.toLowerCase() === (ch.platformHandle || '').toLowerCase(),
          );
          if (match) initial[ch.platformUserId] = match.id;
        });
        setMapping(initial);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load session');
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionToken]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    const toSave = channels
      .filter((ch) => mapping[ch.platformUserId])
      .map((ch) => ({
        channelId:     ch.platformUserId,
        channelHandle: ch.platformHandle,
        brandId:       mapping[ch.platformUserId],
      }));

    if (toSave.length === 0) {
      setError('Map at least one channel to a brand before saving.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      await saveBulkMapping(sessionToken, toSave, token ?? undefined);
      setDone(true);
      setTimeout(() => router.push('/settings/social'), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Find brands already used in the mapping (to avoid mapping two channels to same brand)
  const usedBrands = new Set(Object.values(mapping).filter(Boolean));

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="Connect YouTube — all brands"
        subtitle="Map each YouTube channel to the brand it belongs to. Channels left on '— skip —' are not connected."
      />

      {loading && (
        <div className="flex items-center gap-3 text-muted-foreground py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="af-body">Loading channels…</span>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 af-body text-destructive mb-4">
          {error}
        </div>
      )}

      {done && (
        <div className="rounded-md border border-green-500/40 bg-green-500/10 px-4 py-3 af-body text-green-400 mb-4 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          Channels connected. Redirecting…
        </div>
      )}

      {!loading && !done && channels.length === 0 && !error && (
        <div className="py-12 text-center text-muted-foreground af-body">
          No YouTube channels found on this Google account.
        </div>
      )}

      {!loading && channels.length > 0 && (
        <>
          <div className="rounded-xl border border-border/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/40">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground w-12" />
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">YouTube channel</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Brand</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {channels.map((ch) => {
                  const selectedBrand = brands.find((b) => b.id === mapping[ch.platformUserId]);
                  const isAlreadyMapped = selectedBrand !== undefined;

                  return (
                    <tr key={ch.platformUserId} className="bg-card hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3">
                        {ch.thumbnailUrl ? (
                          <img
                            src={ch.thumbnailUrl}
                            alt=""
                            className="h-8 w-8 rounded-full object-cover ring-1 ring-border/40"
                          />
                        ) : (
                          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                            <YouTubeIcon size={16} />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{ch.platformHandle || ch.platformUserId}</p>
                        <p className="text-xs text-muted-foreground font-mono">{ch.platformUserId}</p>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={mapping[ch.platformUserId] ?? ''}
                          onChange={(e) =>
                            setMapping((prev) => ({ ...prev, [ch.platformUserId]: e.target.value }))
                          }
                          className="w-full rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value="">— skip —</option>
                          {brands.map((b) => (
                            <option
                              key={b.id}
                              value={b.id}
                              disabled={usedBrands.has(b.id) && mapping[ch.platformUserId] !== b.id}
                            >
                              {b.name}{b.is_primary ? ' (primary)' : ''}
                              {usedBrands.has(b.id) && mapping[ch.platformUserId] !== b.id ? ' — already mapped' : ''}
                            </option>
                          ))}
                        </select>
                        {isAlreadyMapped && (
                          <p className="text-xs text-green-400 mt-1 flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            Will connect to <span className="font-medium">{selectedBrand.name}</span>
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-6 flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              {Object.values(mapping).filter(Boolean).length} of {channels.length} channel
              {channels.length === 1 ? '' : 's'} mapped
            </p>
            <div className="flex gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/settings/social')}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || Object.values(mapping).filter(Boolean).length === 0}
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
                  </span>
                ) : (
                  `Save ${Object.values(mapping).filter(Boolean).length} mapping${Object.values(mapping).filter(Boolean).length === 1 ? '' : 's'}`
                )}
              </Button>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
