'use client';
/**
 * Peaks — YouTube Most Replayed / Twitch chat / Kick CCV → customer upload → Short (C1–C11).
 * Browser hop: user downloads/trims locally, uploads MP4 (no server VOD pull on Render).
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/clerk-compat';
import { useBrand } from '@/contexts/brand-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { formatUserError } from '@/lib/job-labels';
import {
  createJob,
  listContentLibraryVods,
  analyzeContentLibraryVod,
  stageContentLibraryLocalFile,
  listComposePresets,
  getKickCcvPeaks,
  type ContentLibraryVod,
  type ContentLibraryPeak,
  type ComposePreset,
  type KickCcvPeak,
} from '@/lib/api';

function formatClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

type SourcePlatform = 'youtube' | 'twitch' | 'kick';

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
  const searchParams = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingPeakRef = useRef<ContentLibraryPeak | null>(null);

  const initialPlatform = ((): SourcePlatform => {
    const p = (searchParams.get('platform') || '').toLowerCase();
    if (p === 'twitch' || p === 'kick' || p === 'youtube') return p;
    return 'youtube';
  })();

  const [sourcePlatform, setSourcePlatform] = useState<SourcePlatform>(initialPlatform);
  const [handle, setHandle] = useState('');
  const [vods, setVods] = useState<ContentLibraryVod[]>([]);
  const [kickPeaks, setKickPeaks] = useState<KickCcvPeak[]>([]);
  const [presets, setPresets] = useState<ComposePreset[]>([]);
  const [presetKey, setPresetKey] = useState('fableflow_speed');
  const [selectedVod, setSelectedVod] = useState<ContentLibraryVod | null>(null);
  const [peaks, setPeaks] = useState<ContentLibraryPeak[]>([]);
  const [analyzeMode, setAnalyzeMode] = useState<string | null>(null);
  const [staged, setStaged] = useState<{ mp4Url?: string; title?: string; duration?: number; startSec?: number; endSec?: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
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

  const loadKickCcvPeaks = useCallback(async () => {
    setBusy('Loading Kick CCV peaks…');
    setError(null);
    setHint(null);
    setPeaks([]);
    setVods([]);
    setSelectedVod(null);
    setStaged(null);
    setAnalyzeMode('kick_ccv');
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const res = await getKickCcvPeaks(token, 20);
      const rows = res.peaks || [];
      setKickPeaks(rows);
      if (res.kickSlug) setHandle(res.kickSlug);
      const segments: ContentLibraryPeak[] = rows.map((p) => ({
        start_sec: p.startSec ?? Math.max(0, (p.peakOffsetSec || 0) - 20),
        end_sec: p.endSec ?? Math.max(5, (p.peakOffsetSec || 0) + 25),
        title: p.title || `Peak ${p.peakViewers} CCV`,
        summary: [
          p.peakClock ? `CCV peak @ ${p.peakClock}` : null,
          `${p.peakViewers} viewers`,
          p.status,
        ].filter(Boolean).join(' · '),
        score: p.peakViewers,
      }));
      setPeaks(segments);
      const withUrl = rows.find((p) => p.vodUrlAtPeak || p.vodUrl);
      if (withUrl) {
        setSelectedVod({
          platform: 'kick',
          streamer: withUrl.kickSlug || res.kickSlug || 'kick',
          vodId: withUrl.vodId || withUrl.id,
          title: withUrl.title || 'Kick stream',
          url: withUrl.vodUrl || withUrl.vodUrlAtPeak || '',
          duration: withUrl.endSec || 0,
        });
      }
      if (!rows.length) {
        setHint(res.hint || 'No Kick CCV peaks yet. Save Kick under My Channels, go live once, then refresh.');
      } else {
        setHint('Peaks found from live CCV. Open at peak → trim → Upload clip — same Short path as YouTube/Twitch.');
      }
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Failed to load Kick peaks'));
      setKickPeaks([]);
      setPeaks([]);
    } finally {
      setBusy(null);
    }
  }, [getToken]);

  const loadVods = useCallback(async (overrideHandle?: string, platformOverride?: SourcePlatform) => {
    const platform = platformOverride || sourcePlatform;
    if (platform === 'kick') {
      await loadKickCcvPeaks();
      return;
    }
    setBusy(platform === 'twitch' ? 'Loading Twitch VODs…' : 'Loading VODs…');
    setError(null);
    setHint(null);
    setPeaks([]);
    setKickPeaks([]);
    setSelectedVod(null);
    setStaged(null);
    setAnalyzeMode(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const res = await listContentLibraryVods(token, {
        handle: overrideHandle || handle || undefined,
        limit: 40,
        platform,
      });
      setVods(res.vods || []);
      if (res.handle) {
        const h = res.handle.replace(/^@/, '');
        setHandle(platform === 'youtube' ? `@${h}` : h);
      }
      if (!(res.vods || []).length) {
        setHint(
          platform === 'twitch'
            ? 'No long Twitch archives found. Connect Twitch under My Channels or enter a login.'
            : 'No long VODs found. Connect YouTube under My Channels or enter @handle.',
        );
      }
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Failed to load VODs'));
      setVods([]);
    } finally {
      setBusy(null);
    }
  }, [getToken, handle, sourcePlatform, loadKickCcvPeaks]);

  useEffect(() => {
    if (!isLoaded) return;
    void loadPresets();
    void loadVods(undefined, sourcePlatform);
  }, [isLoaded, activeBrand?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onAnalyze(vod: ContentLibraryVod) {
    setSelectedVod(vod);
    setPeaks([]);
    setStaged(null);
    setAnalyzeMode(null);
    const plat = (vod.platform === 'twitch' ? 'twitch' : 'youtube') as 'youtube' | 'twitch';
    setBusy(plat === 'twitch' ? 'Analyzing Twitch chat peaks…' : 'Analyzing Most Replayed peaks…');
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
        platform: plat,
        streamer: vod.streamer,
        targetSec: 45,
        maxPeaks: 8,
      }, token);
      setPeaks(res.segments || []);
      setAnalyzeMode(res.mode || null);
      if (!(res.segments || []).length) setHint('No peaks returned — try another VOD.');
      else {
        setHint(
          plat === 'twitch'
            ? 'Peaks found. Open at peak → trim that window on your device → Upload clip. AuraFlux stages it for compose.'
            : 'Peaks found. Open at peak → trim that window on your device → Upload clip. AuraFlux stages it for compose.',
        );
      }
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Analyze failed'));
    } finally {
      setBusy(null);
    }
  }

  function onUploadPeak(peak: ContentLibraryPeak, kickRow?: KickCcvPeak) {
    if (kickRow) {
      setSelectedVod({
        platform: 'kick',
        streamer: kickRow.kickSlug || handle || 'kick',
        vodId: kickRow.vodId || kickRow.id,
        title: kickRow.title || peak.title || 'Kick peak',
        url: kickRow.vodUrl || kickRow.vodUrlAtPeak || '',
        duration: peak.end_sec,
      });
    } else {
    }
    pendingPeakRef.current = peak;
    fileInputRef.current?.click();
  }

  function onUploadAny() {
    pendingPeakRef.current = null;
    fileInputRef.current?.click();
  }

  function openAtPeakHref(peak: ContentLibraryPeak, kickRow?: KickCcvPeak): string | null {
    if (kickRow?.vodUrlAtPeak) return kickRow.vodUrlAtPeak;
    if (kickRow?.vodUrl) {
      const t = Math.floor(kickRow.peakOffsetSec ?? peak.start_sec);
      const sep = kickRow.vodUrl.includes('?') ? '&' : '?';
      return `${kickRow.vodUrl}${sep}t=${t}`;
    }
    if (!selectedVod?.url) return null;
    if (selectedVod.platform === 'kick' || sourcePlatform === 'kick') {
      const t = Math.floor(peak.start_sec);
      const sep = selectedVod.url.includes('?') ? '&' : '?';
      return `${selectedVod.url}${sep}t=${t}`;
    }
    const sep = selectedVod.url.includes('?') ? '&' : '?';
    return `${selectedVod.url}${sep}t=${Math.floor(peak.start_sec)}s`;
  }

  function resolvePlatform(): SourcePlatform {
    if (selectedVod?.platform === 'twitch' || selectedVod?.platform === 'kick') {
      return selectedVod.platform;
    }
    return sourcePlatform;
  }

  async function onFileChosen(file: File | null) {
    if (!file) return;
    const peak = pendingPeakRef.current;
    setBusy(`Uploading ${file.name}…`);
    setUploadPct(0);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const plat = resolvePlatform();
      const res = await stageContentLibraryLocalFile(
        file,
        {
          title: peak?.title || selectedVod?.title || file.name.replace(/\.[^.]+$/, ''),
          streamer: selectedVod?.streamer || 'peaks_upload',
          platform: plat,
          vodUrl: selectedVod?.url,
          vodId: selectedVod?.vodId,
          startSec: peak?.start_sec,
          endSec: peak?.end_sec,
          thumbnailUrl: selectedVod?.thumbnailUrl,
          force: true,
        },
        token,
        (pct) => {
          setUploadPct(pct);
          setBusy(`Uploading… ${pct}%`);
        },
      );
      setStaged({
        mp4Url: res.mp4Url || res.playbackUrl || res.stagedUrl || res.r2Url || undefined,
        title: res.title || peak?.title || file.name,
        duration: res.duration,
        startSec: res.startSec ?? peak?.start_sec,
        endSec: res.endSec ?? peak?.end_sec,
      });
      setHint('Clip staged — scrub the preview, pick a C1–C11 preset (or Custom in Jobs), then create your Short.');
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Upload stage failed'));
    } finally {
      setBusy(null);
      setUploadPct(null);
      pendingPeakRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
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
      const plat = resolvePlatform();
      const result = await createJob({
        contentType: 'clips',
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
            platform: plat,
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

  const stepConnect = true;
  const stepFetch = sourcePlatform === 'kick' ? kickPeaks.length > 0 || !!hint : vods.length > 0;
  const stepPeaks = peaks.length > 0;
  const stepStaged = !!staged?.mp4Url;

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="Peaks"
        subtitle="AuraFlux fetches your VODs and finds the peaks — you trim the window, pick a C1–C11 preset (or custom), preview, then create your Short."
      />

      {/* Creator happy-path strip */}
      <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-2">
        {[
          { n: 1, label: 'Connect', done: stepConnect },
          { n: 2, label: 'Fetch VODs', done: stepFetch },
          { n: 3, label: 'Find peaks', done: stepPeaks },
          { n: 4, label: 'Trim / upload', done: stepStaged },
          { n: 5, label: 'Preset + preview', done: stepStaged },
        ].map((s) => (
          <li
            key={s.n}
            className={cn(
              'rounded-xl border px-3 py-2 text-center',
              s.done ? 'border-primary/40 bg-primary/5' : 'border-border bg-card',
            )}
          >
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Step {s.n}</p>
            <p className={cn('text-xs font-semibold', s.done ? 'text-primary' : 'text-foreground')}>{s.label}</p>
          </li>
        ))}
      </ol>
      <p className="af-caption text-muted-foreground mb-2">
        You do not need to hunt for peaks yourself — pick a VOD, tap <strong>Find peaks</strong>, then open the timestamp and upload your trim.
        {' '}<a href="/settings/channels" className="underline underline-offset-2 hover:text-foreground">My Channels</a>
        {' '}if Fetch is empty.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
        className="hidden"
        onChange={(e) => void onFileChosen(e.target.files?.[0] || null)}
      />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 af-body text-destructive">
          {error}
        </div>
      )}
      {busy && (
        <p className="af-caption text-muted-foreground">
          {busy}
          {uploadPct != null ? ` (${uploadPct}%)` : ''}
        </p>
      )}
      {hint && !error && <p className="af-caption text-muted-foreground">{hint}</p>}
      {analyzeMode && (
        <p className="af-caption text-muted-foreground">Signal: <strong>{analyzeMode}</strong></p>
      )}

      <Card>
        <CardContent className="pt-5 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={sourcePlatform === 'youtube' ? 'default' : 'outline'}
              disabled={!!busy}
              onClick={() => {
                setSourcePlatform('youtube');
                setVods([]);
                setPeaks([]);
                setKickPeaks([]);
                setHandle((h) => (h && !h.startsWith('@') ? `@${h}` : h));
              }}
            >
              YouTube
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sourcePlatform === 'twitch' ? 'default' : 'outline'}
              disabled={!!busy}
              onClick={() => {
                setSourcePlatform('twitch');
                setVods([]);
                setPeaks([]);
                setKickPeaks([]);
                setHandle((h) => h.replace(/^@/, ''));
              }}
            >
              Twitch
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sourcePlatform === 'kick' ? 'default' : 'outline'}
              disabled={!!busy}
              onClick={() => {
                setSourcePlatform('kick');
                setVods([]);
                setPeaks([]);
                setKickPeaks([]);
                setHandle((h) => h.replace(/^@/, ''));
              }}
            >
              Kick
            </Button>
          </div>
          <Label htmlFor="peaks-handle">
            {sourcePlatform === 'twitch'
              ? 'Twitch login'
              : sourcePlatform === 'kick'
                ? 'Kick login'
                : 'YouTube channel'}
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="peaks-handle"
              placeholder={
                sourcePlatform === 'twitch'
                  ? 'channel_login'
                  : sourcePlatform === 'kick'
                    ? 'kick_login'
                    : '@yourchannel'
              }
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              className="max-w-xs"
              disabled={sourcePlatform === 'kick'}
            />
            <Button
              onClick={() => loadVods(handle, sourcePlatform)}
              disabled={!!busy}
            >
              {sourcePlatform === 'kick' ? 'Find peaks (CCV)' : 'Fetch VODs'}
            </Button>
            <Button variant="outline" onClick={onUploadAny} disabled={!!busy}>
              Upload a trim
            </Button>
          </div>
          <p className="af-caption text-muted-foreground">
            {sourcePlatform === 'kick'
              ? 'AuraFlux polls Kick CCV while you are live, then maps the peak to your VOD — open, trim, upload.'
              : 'AuraFlux lists your VODs and finds peaks (Most Replayed / chat). You only trim the window and upload.'}
          </p>
        </CardContent>
      </Card>

      {sourcePlatform !== 'kick' && (
        <div className="grid gap-3 md:grid-cols-2">
          {vods.map((v) => (
            <Card key={v.vodId} className={selectedVod?.vodId === v.vodId ? 'ring-2 ring-primary' : ''}>
              <CardContent className="pt-5 space-y-2">
                <p className="af-body font-medium line-clamp-2">{v.title}</p>
                <p className="af-caption text-muted-foreground">
                  {formatClock(v.duration || 0)}
                  {v.views ? ` · ${v.views.toLocaleString()} views` : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => onAnalyze(v)} disabled={!!busy}>
                    Find peaks
                  </Button>
                  {v.url && (
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }))}
                    >
                      {v.platform === 'twitch' ? 'Open on Twitch' : 'Open on YouTube'}
                    </a>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {peaks.length > 0 && (
        <div className="space-y-3">
          <h2 className="af-label font-medium">
            {sourcePlatform === 'kick' ? 'Peaks AuraFlux found (Kick CCV)' : 'Peaks AuraFlux found'}
          </h2>
          <p className="af-caption text-muted-foreground">
            Open at peak → trim that window on your device → Upload clip. We stage it for C1–C11 compose.
          </p>
          {peaks.map((p, i) => {
            const kickRow = sourcePlatform === 'kick' ? kickPeaks[i] : undefined;
            const openHref = openAtPeakHref(p, kickRow);
            return (
              <Card key={`${p.start_sec}-${i}`}>
                <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="af-body font-medium">
                      {formatClock(p.start_sec)} – {formatClock(p.end_sec)}
                      {p.score != null ? ` · score ${Number(p.score).toFixed(0)}` : ''}
                    </p>
                    <p className="af-caption text-muted-foreground">{p.title || p.summary || 'Peak window'}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {openHref && (
                      <a
                        href={openHref}
                        target="_blank"
                        rel="noreferrer"
                        className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}
                      >
                        Open at peak
                      </a>
                    )}
                    <Button size="sm" onClick={() => onUploadPeak(p, kickRow)} disabled={!!busy}>
                      Upload clip
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {staged?.mp4Url && (
        <Card className="border-primary/30">
          <CardContent className="pt-5 space-y-4">
            <h2 className="af-subhead">Preview · pick preset · create Short</h2>
            <p className="af-caption text-muted-foreground">
              Scrub your staged trim below before assembly. This is your near-final check before credits burn.
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="af-caption font-medium text-foreground">
                  {staged.title}
                  {staged.startSec != null && staged.endSec != null
                    ? ` · ${formatClock(staged.startSec)}–${formatClock(staged.endSec)}`
                    : ''}
                </p>
                <video
                  src={staged.mp4Url}
                  controls
                  playsInline
                  className="w-full aspect-[9/16] max-h-[70vh] rounded-xl bg-black object-contain"
                />
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Compose preset (C1–C11)</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={presetKey}
                    onChange={(e) => setPresetKey(e.target.value)}
                  >
                    {(presets.length ? presets : [
                      { code: 'C9', key: 'fableflow_speed', label: 'Speed cut Short' },
                    ]).map((p) => (
                      <option key={p.key} value={p.key}>{p.code} · {p.label}</option>
                    ))}
                  </select>
                  <p className="af-caption text-muted-foreground">
                    Or build a custom job with this clip prefilled in the job builder.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button onClick={onCreateJob} disabled={!!busy} className="flex-1">
                    Create Short job
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    disabled={!!busy}
                    onClick={() => {
                      try {
                        sessionStorage.setItem('peaks_staged_handoff', JSON.stringify({
                          mp4Url: staged.mp4Url,
                          title: staged.title,
                          duration: staged.duration,
                          presetKey,
                        }));
                      } catch { /* ignore */ }
                      router.push('/myjobs/new?from=peaks');
                    }}
                  >
                    Custom in Jobs
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
