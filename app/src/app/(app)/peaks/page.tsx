'use client';
/**
 * Peaks — YouTube Most Replayed → stage trim → Short job (C1–C11 preset labeled).
 * iss_exFgoTmmRwhP
 */

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/clerk-compat';
import { useBrand } from '@/contexts/brand-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { formatUserError } from '@/lib/job-labels';
import {
  createJob,
  listContentLibraryVods,
  analyzeContentLibraryVod,
  stageContentLibraryVodWindow,
  listComposePresets,
  type ContentLibraryVod,
  type ContentLibraryPeak,
  type ComposePreset,
} from '@/lib/api';

function formatClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export default function PeaksPage() {
  return (
    <Suspense fallback={<PageShell maxWidth="4xl"><PageHeader title="Peaks" subtitle="Loading…" /></PageShell>}>
      <PeaksPageInner />
    </Suspense>
  );
}

function PeaksPageInner() {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand } = useBrand();
  const router = useRouter();

  const [handle, setHandle] = useState('');
  const [vods, setVods] = useState<ContentLibraryVod[]>([]);
  const [presets, setPresets] = useState<ComposePreset[]>([]);
  const [presetKey, setPresetKey] = useState('fableflow_speed');
  const [selectedVod, setSelectedVod] = useState<ContentLibraryVod | null>(null);
  const [peaks, setPeaks] = useState<ContentLibraryPeak[]>([]);
  const [analyzeMode, setAnalyzeMode] = useState<string | null>(null);
  const [staged, setStaged] = useState<{ mp4Url?: string; title?: string; duration?: number; startSec?: number; endSec?: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const loadPresets = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const res = await listComposePresets(token);
      setPresets(res.presets || []);
      if (res.presets?.some((p) => p.key === 'fableflow_speed')) setPresetKey('fableflow_speed');
    } catch { /* optional */ }
  }, [getToken]);

  const loadVods = useCallback(async (overrideHandle?: string) => {
    setBusy('Loading VODs…');
    setError(null);
    setHint(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const res = await listContentLibraryVods(token, {
        handle: overrideHandle || handle || undefined,
        limit: 40,
      });
      setVods(res.vods || []);
      if (res.handle) setHandle(res.handle.startsWith('@') ? res.handle : `@${res.handle}`);
      if (!(res.vods || []).length) {
        setHint('No long VODs found. Connect YouTube under My Channels or enter @handle.');
      }
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Failed to load VODs'));
      setVods([]);
    } finally {
      setBusy(null);
    }
  }, [getToken, handle]);

  useEffect(() => {
    if (!isLoaded) return;
    void loadPresets();
    void loadVods();
  }, [isLoaded, activeBrand?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onAnalyze(vod: ContentLibraryVod) {
    setSelectedVod(vod);
    setPeaks([]);
    setStaged(null);
    setAnalyzeMode(null);
    setBusy('Analyzing Most Replayed peaks…');
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const res = await analyzeContentLibraryVod({
        vodUrl: vod.url,
        vodId: vod.vodId,
        title: vod.title,
        durationSec: vod.duration,
        views: vod.views,
        platform: 'youtube',
        streamer: vod.streamer,
        targetSec: 45,
        maxPeaks: 8,
      }, token);
      setPeaks(res.segments || []);
      setAnalyzeMode(res.mode || null);
      if (!(res.segments || []).length) setHint('No peaks returned — try another VOD.');
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Analyze failed'));
    } finally {
      setBusy(null);
    }
  }

  async function onStage(peak: ContentLibraryPeak) {
    if (!selectedVod) return;
    setBusy('Staging peak window to R2…');
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const res = await stageContentLibraryVodWindow({
        vodUrl: selectedVod.url,
        vodId: selectedVod.vodId,
        startSec: peak.start_sec,
        endSec: peak.end_sec,
        title: peak.title || selectedVod.title,
        streamer: selectedVod.streamer,
        platform: 'youtube',
        thumbnailUrl: selectedVod.thumbnailUrl,
      }, token);
      setStaged({
        mp4Url: res.mp4Url || res.playbackUrl || res.stagedUrl || res.r2Url || undefined,
        title: res.title || peak.title,
        duration: res.duration,
        startSec: res.startSec,
        endSec: res.endSec,
      });
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Stage failed'));
    } finally {
      setBusy(null);
    }
  }

  async function onCreateJob() {
    if (!staged?.mp4Url) return;
    setBusy('Creating Short job…');
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const preset = presets.find((p) => p.key === presetKey);
      const result = await createJob({
        contentType: 'clip_comp',
        entryType: 'fetch',
        platforms: ['youtube'],
        formFactor: 'short',
        productionPath: 'short_compile_clips',
        createdVia: 'dashboard',
        brandId: activeBrand?.id,
        topic: staged.title || 'Peak highlight',
        durationMins: Math.max(1, Math.ceil((staged.duration || 45) / 60)),
        fetchSpec: {
          sourceUrls: [staged.mp4Url],
          sourceLibrary: [{
            url: staged.mp4Url,
            title: staged.title,
            duration: staged.duration,
            platform: 'youtube',
            contentType: 'vod_peak',
          }],
        },
        featureConfig: {
          compose: {
            preset: presetKey,
            presetCode: preset?.code || 'C9',
            peakStartSec: String(staged.startSec ?? ''),
            peakEndSec: String(staged.endSec ?? ''),
          },
        },
        staging: true,
      }, token);
      const jobId = result.jobId || result.job?.jobId;
      if (jobId) router.push(`/myjobs/${jobId}`);
      else setHint(result.message || 'Job created — check My Jobs.');
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Create job failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="Peaks"
        subtitle="Pull YouTube VODs → Most Replayed peaks → trim → Short (C1–C11). Publish to YouTube when ready."
      />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 af-body text-destructive">
          {error}
        </div>
      )}
      {busy && <p className="af-caption text-muted-foreground">{busy}</p>}
      {hint && !error && <p className="af-caption text-muted-foreground">{hint}</p>}
      {analyzeMode && (
        <p className="af-caption">Analyze mode: <strong>{analyzeMode}</strong></p>
      )}

      <Card>
        <CardContent className="pt-5 space-y-3">
          <Label htmlFor="yt-handle">YouTube channel</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="yt-handle"
              placeholder="@yourchannel"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              className="max-w-xs"
            />
            <Button onClick={() => loadVods(handle)} disabled={!!busy}>
              Fetch VODs
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        {vods.map((v) => (
          <Card key={v.vodId} className={selectedVod?.vodId === v.vodId ? 'ring-2 ring-primary' : ''}>
            <CardContent className="pt-5 space-y-2">
              <p className="af-body font-medium line-clamp-2">{v.title}</p>
              <p className="af-caption text-muted-foreground">
                {formatClock(v.duration || 0)}
                {v.views ? ` · ${v.views.toLocaleString()} views` : ''}
              </p>
              <Button size="sm" variant="outline" onClick={() => onAnalyze(v)} disabled={!!busy}>
                Analyze peaks
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {peaks.length > 0 && (
        <div className="space-y-3">
          <h2 className="af-label font-medium">Peaks</h2>
          {peaks.map((p, i) => (
            <Card key={`${p.start_sec}-${i}`}>
              <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="af-body font-medium">
                    {formatClock(p.start_sec)} – {formatClock(p.end_sec)}
                    {p.score != null ? ` · score ${Number(p.score).toFixed(2)}` : ''}
                  </p>
                  <p className="af-caption text-muted-foreground">{p.title || p.summary || 'Peak window'}</p>
                </div>
                <Button size="sm" onClick={() => onStage(p)} disabled={!!busy}>
                  Stage trim
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {staged?.mp4Url && (
        <Card>
          <CardContent className="pt-5 space-y-4">
            <h2 className="af-label font-medium">Staged · ready for compose</h2>
            <p className="af-caption">
              {staged.title} · {formatClock(staged.startSec || 0)}–{formatClock(staged.endSec || 0)}
            </p>
            <video src={staged.mp4Url} controls className="w-full max-w-md rounded-md bg-black" />
            <div className="space-y-2">
              <Label>Compose preset</Label>
              <select
                className="flex h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm"
                value={presetKey}
                onChange={(e) => setPresetKey(e.target.value)}
              >
                {(presets.length ? presets : [
                  { code: 'C9', key: 'fableflow_speed', label: 'FableFlow Speed' },
                ]).map((p) => (
                  <option key={p.key} value={p.key}>{p.code} · {p.label}</option>
                ))}
              </select>
              <p className="af-caption text-muted-foreground">
                Preset is saved on the job. Full C9–C11 assembly looks continue to land; trim + YouTube publish work now.
              </p>
            </div>
            <Button onClick={onCreateJob} disabled={!!busy}>
              Create Short job (YouTube)
            </Button>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
