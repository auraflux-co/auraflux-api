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
  renderCompositionTimelinePreview,
  compositionPreviewFileUrl,
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
type VodWindow = 'last24h' | 'last7d' | 'last30d' | '7d' | '30d' | 'all' | 'any';
type VodSort = 'recent' | 'popular';

const VOD_WINDOW_PILLS: { id: VodWindow; label: string }[] = [
  { id: 'last24h', label: 'Last 24H' },
  { id: 'last7d', label: 'Last 7D' },
  { id: 'last30d', label: 'Last 30D' },
  { id: '7d', label: '24H–7D' },
  { id: '30d', label: '7D–30D' },
  { id: 'all', label: '30D+' },
  { id: 'any', label: 'All time' },
];

export default function PeaksPage() {
  return (
    <Suspense fallback={<PageShell maxWidth="4xl"><PageHeader title="Peaks" subtitle="Loading…" /></PageShell>}>
      <PeaksPageInner />
    </Suspense>
  );
}

function PeaksPageInner() {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand, isLoading: brandLoading } = useBrand();
  const router = useRouter();
  const searchParams = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingPeakRef = useRef<ContentLibraryPeak | null>(null);
  const loadVodsGenRef = useRef(0);

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
  const [nearFinalUrl, setNearFinalUrl] = useState<string | null>(null);
  const [nearFinalMeta, setNearFinalMeta] = useState<{ applied: string[]; missing: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [vodWindow, setVodWindow] = useState<VodWindow>('last7d');
  const [minDurationSec, setMinDurationSec] = useState(180);
  const [maxDurationSec, setMaxDurationSec] = useState('');
  const [vodSort, setVodSort] = useState<VodSort>('recent');
  const hasFetchedVodsRef = useRef(false);

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
    const gen = ++loadVodsGenRef.current;
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
      const maxDur = maxDurationSec.trim() === '' ? null : Math.max(0, parseInt(maxDurationSec, 10) || 0);
      const listLimit = vodWindow === 'any' || vodWindow === 'all' ? 200 : 40;
      const res = await listContentLibraryVods(token, {
        handle: overrideHandle || handle || undefined,
        limit: listLimit,
        platform,
        window: vodWindow,
        minDurationSec,
        maxDurationSec: maxDur,
        sort: vodSort,
      });
      if (gen !== loadVodsGenRef.current) return; // stale response — brand switched mid-flight
      hasFetchedVodsRef.current = true;
      setVods(res.vods || []);
      const resolvedHandle = res.handle
        ? (platform === 'youtube' ? `@${res.handle.replace(/^@/, '')}` : res.handle.replace(/^@/, ''))
        : (overrideHandle || handle || '');
      if (res.handle) setHandle(resolvedHandle);
      if (!(res.vods || []).length) {
        const skipped = res.shortsSkipped ?? null;
        const winLabel = res.windowLabel || vodWindow;
        const minLabel = `${minDurationSec}s`;
        if (platform === 'twitch') {
          setHint(
            resolvedHandle
              ? `No Twitch archives ≥${minLabel} in ${winLabel} for ${resolvedHandle}. Try All time, lower min duration, or another login.`
              : 'No long Twitch archives found. Connect Twitch under My Channels or enter a login.',
          );
        } else {
          setHint(
            resolvedHandle
              ? `No YouTube VODs ≥${minLabel} in ${winLabel} for ${resolvedHandle}${skipped ? ` (skipped ${skipped} Shorts/under-min)` : ''}. Try All time or lower min duration.`
              : 'No long VODs found. Connect YouTube under My Channels or enter @handle.',
          );
        }
      }
    } catch (e) {
      if (gen !== loadVodsGenRef.current) return;
      setError(formatUserError(e instanceof Error ? e.message : 'Failed to load VODs'));
      setVods([]);
    } finally {
      if (gen === loadVodsGenRef.current) setBusy(null);
    }
  }, [getToken, handle, sourcePlatform, loadKickCcvPeaks, vodWindow, minDurationSec, maxDurationSec, vodSort]);

  useEffect(() => {
    // Wait for brand context — early fetch without X-Brand-Id can resolve the wrong channel
    // and a late empty response can overwrite a good one.
    if (!isLoaded || brandLoading) return;
    void loadPresets();
    // Library paste → peaks handoff: skip auto VOD fetch so we keep pasted segments.
    if (searchParams.get('from') === 'library') return;
    void loadVods(undefined, sourcePlatform);
  }, [isLoaded, brandLoading, activeBrand?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // After first fetch, window/sort pill changes re-fetch (duration applies on Fetch).
  useEffect(() => {
    if (!isLoaded || brandLoading || sourcePlatform === 'kick') return;
    if (!hasFetchedVodsRef.current) return;
    void loadVods(undefined, sourcePlatform);
  }, [vodWindow, vodSort]); // eslint-disable-line react-hooks/exhaustive-deps

  // Library → Peaks handoff (paste URL analyze)
  useEffect(() => {
    if (searchParams.get('from') !== 'library') return;
    try {
      const raw = sessionStorage.getItem('library_peaks_handoff');
      if (!raw) return;
      sessionStorage.removeItem('library_peaks_handoff');
      const data = JSON.parse(raw) as {
        url?: string;
        platform?: string;
        segments?: ContentLibraryPeak[];
        mode?: string;
      };
      if (!data.url) return;
      const plat = (
        data.platform === 'twitch' || data.platform === 'kick' || data.platform === 'youtube'
          ? data.platform
          : 'youtube'
      ) as SourcePlatform;
      setSourcePlatform(plat);
      setSelectedVod({
        platform: plat,
        streamer: 'library',
        vodId: data.url,
        title: 'Pasted from Library',
        url: data.url,
        duration: 0,
      });
      const segments = data.segments || [];
      setPeaks(segments);
      setAnalyzeMode(data.mode || 'library_paste');
      setStaged(null);
      hasFetchedVodsRef.current = true;
      setHint(
        segments.length
          ? `From Library — ${segments.length} peak${segments.length === 1 ? '' : 's'} ready. Pick one to trim & upload.`
          : 'From Library — URL opened here. Fetch VODs or upload a trim to continue.',
      );
    } catch { /* ignore bad handoff */ }
  }, [searchParams]);

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
            ? 'Peaks found. Open at peak → trim that window on your device → Upload clip.'
            : 'Peaks found. Open at peak → trim that window on your device → Upload clip.',
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
      setNearFinalUrl(null);
      setNearFinalMeta(null);
      setHint('Clip uploaded — pick an edit style, build a preview, then Create Short.');
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Upload failed'));
    } finally {
      setBusy(null);
      setUploadPct(null);
      pendingPeakRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function onReviewNearFinal() {
    if (!staged?.mp4Url) return;
    setBusy('Building preview…');
    setError(null);
    setNearFinalUrl(null);
    setNearFinalMeta(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const res = await renderCompositionTimelinePreview({
        clip: {
          mp4Url: staged.mp4Url,
          resolvedMp4: staged.mp4Url,
          title: staged.title,
          duration: staged.duration,
          trimStart: 0,
          trimEnd: staged.duration,
        },
        compCreativePreset: presetKey,
        brandId: activeBrand?.id,
        deliveryAspect: '9:16',
      }, token);
      const rel = res.previewVideoAbsoluteUrl || res.previewVideoUrl;
      if (!rel) throw new Error(res.error || 'Preview encode returned no video');
      setNearFinalUrl(compositionPreviewFileUrl(rel));
      setNearFinalMeta({
        applied: res.nearFinalApplied || [],
        missing: res.nearFinalMissing || [],
      });
      setHint('Preview ready — review it, then Create Short when it looks right.');
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Preview failed'));
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
      const plat = resolvePlatform();
      const cp = (activeBrand as { creative_profile?: { captionStyle?: string; audioBed?: string } } | null)?.creative_profile;
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
            ...(cp?.captionStyle ? { captionStyle: cp.captionStyle } : {}),
            ...(cp?.audioBed ? { audioBed: cp.audioBed } : {}),
          },
        },
        staging: true,
      }, token);
      const jobId = result.jobId || result.job?.jobId;
      if (jobId) router.push(`/myjobs/${jobId}`);
      else setHint(result.message || 'Job created — check Jobs.');
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Create job failed'));
    } finally {
      setBusy(null);
    }
  }

  function clearPeaksSelection() {
    setPeaks([]);
    setKickPeaks([]);
    setSelectedVod(null);
    setAnalyzeMode(null);
    setStaged(null);
    setNearFinalUrl(null);
    setNearFinalMeta(null);
    setHint(null);
    setError(null);
  }

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="Peaks"
        subtitle="Pick a VOD, find peaks, trim & upload, preview your edit style, then create your Short."
      />

      <p className="af-caption text-muted-foreground mb-4">
        Need a channel first?{' '}
        <a href="/settings/channels" className="underline underline-offset-2 hover:text-foreground">My Channels</a>
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
      {analyzeMode && (
        <p className="af-caption text-muted-foreground">Signal: <strong>{analyzeMode}</strong></p>
      )}

      {hint && !error && (
        <div className="bg-amber-400/10 border border-amber-400/20 text-amber-300 rounded-xl p-3 text-xs font-medium mb-4">
          {hint}
        </div>
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
            <Button
              variant="outline"
              onClick={onUploadAny}
              disabled={!!busy}
              className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold px-4 py-2.5 rounded-xl text-xs transition-colors"
            >
              Upload a trim
            </Button>
          </div>

          {sourcePlatform !== 'kick' && (
            <div className="space-y-3 pt-1 border-t border-slate-800">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">When</p>
                <div className="flex flex-wrap gap-1.5">
                  {VOD_WINDOW_PILLS.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      disabled={!!busy}
                      onClick={() => setVodWindow(w.id)}
                      className={cn(
                        'rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
                        vodWindow === w.id
                          ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                          : 'border-slate-800 text-slate-500 hover:border-slate-700 hover:text-slate-300',
                      )}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label htmlFor="peaks-min-dur" className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Min duration (s)</Label>
                  <Input
                    id="peaks-min-dur"
                    type="number"
                    min={0}
                    step={1}
                    value={minDurationSec}
                    onChange={(e) => setMinDurationSec(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="w-24 mt-1"
                    disabled={!!busy}
                  />
                </div>
                <div>
                  <Label htmlFor="peaks-max-dur" className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Max duration (s)</Label>
                  <Input
                    id="peaks-max-dur"
                    type="number"
                    min={0}
                    step={1}
                    placeholder="any"
                    value={maxDurationSec}
                    onChange={(e) => setMaxDurationSec(e.target.value)}
                    className="w-24 mt-1"
                    disabled={!!busy}
                  />
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Sort</p>
                  <div className="flex gap-1.5">
                    {(["recent", "popular"] as VodSort[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={!!busy}
                        onClick={() => setVodSort(s)}
                        className={cn(
                          'rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold capitalize transition-colors',
                          vodSort === s
                            ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                            : 'border-slate-800 text-slate-500 hover:border-slate-700 hover:text-slate-300',
                        )}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="af-label font-medium">
              {sourcePlatform === 'kick' ? 'Peaks found (Kick CCV)' : 'Peaks found'}
            </h2>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
              onClick={clearPeaksSelection}
              disabled={!!busy}
            >
              {sourcePlatform === 'kick' ? 'Clear peaks' : 'Back to VODs'}
            </Button>
          </div>
          <p className="af-caption text-muted-foreground">
            Open at peak → trim that window on your device → Upload clip. We’ll prepare it with your edit style.
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
            <h2 className="af-subhead">Preview · create Short</h2>
            <p className="af-caption text-muted-foreground">
              {nearFinalUrl
                ? 'Review the preview (layout, look, and effects). Credits are used only when you Create Short.'
                : 'Review your trim, pick an edit style, then preview before Create Short.'}
            </p>
            {activeBrand && (
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 space-y-1">
                <p className="af-caption font-medium">Brand Profile · {activeBrand.name}</p>
                <p className="af-caption text-muted-foreground">
                  Near-final and Create Short use this brand’s creative profile (captions, audio bed, colors).
                  Switch brands in the header to swap defaults. Thumbnail peak picker, sponsor markers, guest review, and playlist strategy land on Review / job detail after the Short finishes.
                </p>
                {(activeBrand as { creative_profile?: { captionStyle?: string | null; audioBed?: string | null } }).creative_profile && (
                  <p className="af-caption text-muted-foreground">
                    Active: captions {(activeBrand as { creative_profile?: { captionStyle?: string | null } }).creative_profile?.captionStyle || 'default'}
                    {' · '}
                    bed {(activeBrand as { creative_profile?: { audioBed?: string | null } }).creative_profile?.audioBed || 'off'}
                  </p>
                )}
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="af-caption font-medium text-foreground">
                  {nearFinalUrl ? 'Preview · ' : 'Uploaded · '}{staged.title}
                  {staged.startSec != null && staged.endSec != null
                    ? ` · ${formatClock(staged.startSec)}–${formatClock(staged.endSec)}`
                    : ''}
                </p>
                <video
                  key={nearFinalUrl || staged.mp4Url}
                  src={nearFinalUrl || staged.mp4Url}
                  controls
                  playsInline
                  className="w-full aspect-[9/16] max-h-[70vh] rounded-xl bg-black object-contain"
                />
                {nearFinalMeta && (
                  <p className="af-caption text-muted-foreground">
                    Applied: {nearFinalMeta.applied.length ? nearFinalMeta.applied.join(', ') : 'base layout'}
                    {nearFinalMeta.missing.length ? ` · Later at execute: ${nearFinalMeta.missing.join(', ')}` : ''}
                  </p>
                )}
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Edit style</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={presetKey}
                    onChange={(e) => {
                      setPresetKey(e.target.value);
                      setNearFinalUrl(null);
                      setNearFinalMeta(null);
                    }}
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
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant={nearFinalUrl ? 'outline' : 'default'}
                    onClick={onReviewNearFinal}
                    disabled={!!busy}
                    className="w-full"
                  >
                    {nearFinalUrl ? 'Refresh preview' : 'Build preview'}
                  </Button>
                  <Button onClick={onCreateJob} disabled={!!busy} className="w-full">
                    Create Short job
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
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
