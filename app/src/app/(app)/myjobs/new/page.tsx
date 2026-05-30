'use client';
/**
 * /myjobs/new — Single-page job builder (CPD-443)
 *
 * Replaces the 4-step wizard with a template-first, single-page design.
 * Sections are collapsible — templates pre-fill everything; Build My Own
 * opens every section from scratch.
 *
 * Preserved from the old wizard:
 *   - ClipEditor (compact + extract modes)
 *   - VideoUpload
 *   - SourceLibraryPicker
 *   - All production features with inline config panels
 *   - Credit estimation + plan gating + LockedFeature
 *   - ?templateId= pre-fill from URL
 *   - AuraFlux Guide context hints
 *
 * Removed (moved to review queue / schedule page):
 *   - JobTimingPicker publish timing
 *   - Recurring template creation
 *   - Step 3 order review (replaced by sticky right summary)
 */

import { useState, useTransition, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { toast } from 'sonner';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { createJob, estimateCreditCost, getTemplateById, type CreateJobPayload } from '@/lib/api';
import { VideoUpload } from '@/components/upload/video-upload';
import { LockedFeature } from '@/components/ui/locked-feature';
import { SparkAnvil } from '@/components/icons/brand-icons';
import { useGuide } from '@/contexts/guide-context';
import { usePlan } from '@/contexts/plan-context';
import { SourceLibraryPicker } from '@/components/jobs/source-library-picker';
import { ClipEditor, type ClipSpec, type CompactClip, type ExtractClip } from '@/components/jobs/clip-editor';
import type { SourceItem } from '@/lib/api';
import {
  CollapsibleSection,
  ChipGroup,
  FramePreview,
  TemplateGrid,
  PRESET_TEMPLATES,
  type JobTemplate,
} from '@/components/jobs/job-builder';

// ─── Types ────────────────────────────────────────────────────────────────────

type PlanTier    = 'operate' | 'guided' | 'managed' | 'custom';
type FormFactor  = 'long' | 'short';
type SourceMode  = 'source' | 'upload';

type ProductionPath =
  | 'long_compile_clips'
  | 'long_produce_source'
  | 'short_cut_longform'
  | 'short_enhance_upload'
  | 'short_fetch_enhance';

interface Feature {
  id:           string;
  label:        string;
  description:  string;
  tooltip:      string;
  outputImpact: string;
  default:      boolean;
  formFactors:  ('long' | 'short')[];
  requires?:    string[];
  minPlan?:     PlanTier;
  hasConfig:    boolean;
  advanced?:    boolean;
  category:     'content' | 'editing' | 'effects' | 'brand';
  status:       'live' | 'sprint7' | 'sprint8';
}

interface CategoryBox {
  id:          'content' | 'editing' | 'effects' | 'brand';
  label:       string;
  description: string;
  icon:        string;
  formFactors: ('long' | 'short')[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

const FORMATS = [
  { id: 'portrait',  label: '9:16 Portrait',  sub: 'Shorts · TikTok · Reels' },
  { id: 'square',    label: '1:1 Square',      sub: 'Instagram feed' },
  { id: 'landscape', label: '16:9 Short',      sub: 'YouTube · Twitter' },
  { id: 'longform',  label: '16:9 Long-form',  sub: '5–30 min · YouTube' },
];

const DUR_SHORT = [
  { id: '15s',  label: '15 seconds' },
  { id: '30s',  label: '30 seconds' },
  { id: '60s',  label: '60 seconds' },
  { id: '90s',  label: '90 seconds' },
];

const DUR_LONG = [
  { id: '5min',  label: '5 minutes' },
  { id: '10min', label: '10 minutes' },
  { id: '15min', label: '15 minutes' },
  { id: '30min', label: '30 minutes' },
];

const PLATFORMS = [
  { id: 'youtube',   label: 'YouTube'   },
  { id: 'tiktok',    label: 'TikTok'    },
  { id: 'instagram', label: 'Instagram' },
];

const GRADES = [
  { id: 'none', label: 'None'    },
  { id: 'warm', label: 'Warm'    },
  { id: 'cool', label: 'Cool'    },
  { id: 'neut', label: 'Neutral' },
];

const EFFECTS_OPTS = [
  { id: 'transitions', label: 'Scene transitions' },
  { id: 'zoom',        label: 'Zoom punch'        },
  { id: 'slowmo',      label: 'Slow motion'       },
  { id: 'vignette',    label: 'Vignette'          },
];

const AUDIO_OPTS = [
  { id: 'loudnorm', label: 'Volume balance', sub: 'Consistent loudness'  },
  { id: 'duck',     label: 'Music ducking',  sub: 'Dips under speech'    },
  { id: 'denoise',  label: 'Noise removal',  sub: 'Clean background'     },
];

const FEATURES: Feature[] = [
  {
    id: 'script', label: 'Write my script',
    description: 'AI writes the video script from your source material',
    tooltip: 'Gemini analyses your source and writes a structured script.',
    outputImpact: 'Your video gets a structured script — intro, key segments, and a close.',
    default: true, formFactors: ['long'], hasConfig: true, category: 'content', status: 'live',
  },
  {
    id: 'tts', label: 'AI voiceover',
    description: 'AI voice narrates the generated script',
    tooltip: 'A professional AI voice reads your script in the video.',
    outputImpact: 'A professional voice reads your script — no recording needed.',
    default: false, formFactors: ['long'], requires: ['script'], hasConfig: true, advanced: true,
    category: 'content', status: 'live',
  },
  {
    id: 'commentary', label: 'Commentary style',
    description: 'Narrative text commentary timed to footage',
    tooltip: 'Text overlays appear timed to key moments.',
    outputImpact: 'Commentary text appears timed to key moments.',
    default: false, formFactors: ['long'], hasConfig: true, advanced: true,
    category: 'content', status: 'live',
  },
  {
    id: 'generation', label: 'Video generation',
    description: 'AI-generated clips fill missing footage',
    tooltip: 'Where source footage is missing, AI generates matching clips.',
    outputImpact: 'Gaps in footage are filled with generated clips.',
    default: false, formFactors: ['long'], hasConfig: true, advanced: true,
    category: 'content', status: 'live',
  },
  {
    id: 'scene_select', label: 'Smart clip selection',
    description: 'AI picks the best clips from your source',
    tooltip: 'Only the most relevant and energetic segments are used.',
    outputImpact: 'Only the most relevant segments are used — weak clips are cut.',
    default: true, formFactors: ['long', 'short'], hasConfig: false, category: 'editing', status: 'live',
  },
  {
    id: 'burn_images', label: 'Image segments',
    description: 'Embed still images as overlay segments',
    tooltip: 'Embed images as timed segments in the assembled video.',
    outputImpact: 'Your images appear in the video at the position and duration you specify.',
    default: false, formFactors: ['long', 'short'], hasConfig: true, advanced: true,
    category: 'editing', status: 'live',
  },
  {
    id: 'dynamic', label: 'Animated overlays',
    description: 'Animated text, scoreboards, and motion graphics',
    tooltip: 'Live data overlays — scores, stats, headlines — animated in your brand style.',
    outputImpact: 'Live data overlays are animated into the video using your brand style.',
    default: false, formFactors: ['long', 'short'], hasConfig: false, category: 'effects', status: 'live',
  },
  {
    id: 'branding', label: 'Branded intro/outro',
    description: 'Apply your brand config across the video',
    tooltip: 'Your logo, colour palette, and branded intro/outro are applied consistently.',
    outputImpact: 'Your brand logo, colour palette, and lower-third templates are applied.',
    default: true, formFactors: ['long', 'short'], hasConfig: false, category: 'brand', status: 'live',
  },
];

const CATEGORY_BOXES: CategoryBox[] = [
  { id: 'content',  label: 'Content & Script',  description: 'Write, voice, and narrate your video', icon: '✍️', formFactors: ['long'] },
  { id: 'editing',  label: 'Editing & Pacing',  description: 'Smart cuts, clip selection, and timing', icon: '✂️', formFactors: ['long', 'short'] },
  { id: 'effects',  label: 'Effects & Audio',   description: 'Overlays, animations, and sound',       icon: '✨', formFactors: ['long', 'short'] },
  { id: 'brand',    label: 'Design & Brand',    description: 'Thumbnails, intros, and brand identity', icon: '🎨', formFactors: ['long', 'short'] },
];

const ALL_SECTIONS = ['type', 'source', 'format', 'platform', 'production', 'schedule'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function durLabel(id: string): string {
  return [...DUR_SHORT, ...DUR_LONG].find((d) => d.id === id)?.label ?? id;
}

function fmtSecs(s: number): string {
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function pathToContentType(path: ProductionPath): string {
  switch (path) {
    case 'long_compile_clips':   return 'clips-long';
    case 'long_produce_source':  return 'custom';
    case 'short_cut_longform':   return 'clips-short';
    case 'short_enhance_upload': return 'custom';
    case 'short_fetch_enhance':  return 'custom';
  }
}

// ─── Main page ────────────────────────────────────────────────────────────────

function JobBuilderPageInner() {
  const router         = useRouter();
  const searchParams   = useSearchParams();
  const { getToken }   = useAuth();
  const [isPending, start] = useTransition();

  const { openWithContext, setContextHint } = useGuide();
  const { planTier } = usePlan();

  const [error, setError] = useState<string | null>(null);

  // ── Template state ──
  const [templateId,      setTemplateId]      = useState('');
  const [templatePicked,  setTemplatePicked]  = useState(false);
  const [templateBanner,  setTemplateBanner]  = useState<string | null>(null);
  const [openSections,    setOpenSections]    = useState<string[]>(ALL_SECTIONS);

  // ── Form state ──
  const [formFactor,     setFormFactor]     = useState<FormFactor | null>(null);
  const [sourceIntent,   setSourceIntent]   = useState<'clips' | 'longform' | null>(null);
  const [sourceMode,     setSourceMode]     = useState<SourceMode>('source');
  const [sourceItems,    setSourceItems]    = useState<SourceItem[]>([]);
  const [fileKeys,       setFileKeys]       = useState('');
  const [uploadedKey,    setUploadedKey]    = useState<string | null>(null);
  const [uploadedName,   setUploadedName]   = useState<string | null>(null);
  const [clipSpec,       setClipSpec]       = useState<ClipSpec | null>(null);
  const [showClipEditor, setShowClipEditor] = useState(false);
  const [format,         setFormat]         = useState('portrait');
  const [duration,       setDuration]       = useState('60s');
  const [platforms,      setPlatforms]      = useState<string[]>([]);
  const [captions,       setCaptions]       = useState(false);
  const [voiceover,      setVoiceover]      = useState(false);
  const [grade,          setGrade]          = useState('none');
  const [effects,        setEffects]        = useState<string[]>([]);
  const [audioOpts,      setAudioOpts]      = useState<string[]>(['loudnorm']);
  const [features,       setFeatures]       = useState<Set<string>>(new Set());
  const [featureConfig,  setFeatureConfig]  = useState<Record<string, Record<string, string>>>({});
  const [expandedBoxes,  setExpandedBoxes]  = useState<Set<string>>(new Set(['content', 'editing', 'brand']));
  const [scheduledStart, setScheduledStart] = useState<'now' | 'scheduled'>('now');
  const [scheduledAt,    setScheduledAt]    = useState('');
  const [tone,           setTone]           = useState('professional');
  const [durationMins,   setDurationMins]   = useState(3);

  // ── Derived ──
  const inferredMultiClip  = sourceIntent === 'clips' && formFactor === 'long';
  const isLongForm         = format === 'longform' || formFactor === 'long';
  const durations          = isLongForm ? DUR_LONG : DUR_SHORT;
  const totalSecs          = sourceItems.reduce((s, i) => s + (i.duration ?? 0), 0);
  const canSubmit          = !!formFactor && platforms.length > 0 &&
    (sourceMode === 'source' ? sourceItems.length > 0 : !!fileKeys.trim());

  const tier = (planTier ?? 'operate') as PlanTier;

  const estimate = estimateCreditCost({
    durationMins,
    features: Array.from(features),
    extensions: [],
    sourceMode: sourceMode === 'source' ? 'source' : 'upload',
    planTier: tier,
  });

  // ─── Section helpers ───────────────────────────────────────────────────────

  const isOpen   = (id: string) => openSections.includes(id);
  const toggle   = (id: string) => setOpenSections((prev) =>
    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
  );

  // ─── Template apply ────────────────────────────────────────────────────────

  function applyTemplate(t: JobTemplate) {
    setTemplateId(t.id);
    setTemplatePicked(true);
    setFormFactor(t.formFactor);
    setSourceIntent(t.sourceIntent);
    setFormat(t.format);
    setPlatforms(t.platforms);
    setCaptions(t.captions);
    setVoiceover(t.voiceover);
    setGrade(t.grade);
    setEffects(t.effects);
    setAudioOpts(t.audioOpts);
    setFeatures(new Set(t.features));
    setDuration(t.formFactor === 'long' ? '10min' : '60s');
    setDurationMins(t.formFactor === 'long' ? 10 : 3);
    setSourceItems([]);
    setClipSpec(null);
    setShowClipEditor(false);
    // Collapse everything except Source (the one thing templates can't pre-fill)
    setOpenSections(['source']);
  }

  function pickBuildMyOwn() {
    setTemplateId('custom');
    setTemplatePicked(true);
    setOpenSections(ALL_SECTIONS);
    setPlatforms([]);
    setCaptions(false);
    setVoiceover(false);
    setGrade('none');
    setEffects([]);
    setAudioOpts([]);
    setFeatures(new Set());
    setSourceItems([]);
    setClipSpec(null);
    setFormFactor(null);
    setSourceIntent(null);
    setFormat('portrait');
    setDuration('60s');
    setDurationMins(3);
  }

  function changeTemplate() {
    setTemplatePicked(false);
    setTemplateId('');
    setOpenSections(ALL_SECTIONS);
  }

  // ─── URL template pre-fill ─────────────────────────────────────────────────

  useEffect(() => {
    const tid = searchParams.get('templateId');
    if (!tid) return;
    (async () => {
      try {
        const token    = await getToken();
        const { template } = await getTemplateById(tid, token ?? undefined);
        const spec     = template.jobSpec as Record<string, unknown>;
        const ff       = (spec.formFactor as FormFactor) || null;
        if (ff) setFormFactor(ff);
        const feats    = spec.features as string[] | undefined;
        if (feats?.length) setFeatures(new Set(feats));
        if (template.platforms?.length) setPlatforms(template.platforms);
        const dur      = spec.durationMins as number | undefined;
        if (dur) setDurationMins(dur);
        setTemplateBanner(template.name);
        setTemplatePicked(true);
        setTemplateId('saved:' + tid);
        setOpenSections(['source']);
      } catch { /* template not found — silent */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Guide ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    openWithContext('Job builder — Ask me about templates, source options, or features.');
    setContextHint('Job builder — single page. Ask me anything about configuration.');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Feature helpers ───────────────────────────────────────────────────────

  function toggleFeature(id: string) {
    setFeatures((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function setFeatureCfg(fid: string, key: string, value: string) {
    setFeatureConfig((prev) => ({ ...prev, [fid]: { ...(prev[fid] ?? {}), [key]: value } }));
  }

  // ─── Duration auto-calc ────────────────────────────────────────────────────

  function calcDuration(spec: ClipSpec | null): number {
    if (!spec) {
      const totalSec = sourceItems.reduce((s, i) => s + (i.duration ?? 0), 0);
      const factor   = sourceIntent === 'longform' ? 0.15 : 0.70;
      return Math.max(1, Math.min(15, Math.round((totalSec * factor) / 60)));
    }
    let sec = 0;
    if (spec.mode === 'compact') {
      (spec.clips as CompactClip[]).forEach((c) => { sec += (c.trimEnd ?? c.durationHint ?? 0) - c.trimStart; });
    } else {
      (spec.clips as ExtractClip[]).forEach((c) => { sec += c.endTime - c.startTime; });
    }
    return Math.max(1, Math.min(15, Math.round(sec / 60)));
  }

  // ─── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    setError(null);
    if (!formFactor) { setError('Select a format to continue'); return; }
    if (platforms.length === 0) { setError('Select at least one platform'); return; }

    const inferredPath: ProductionPath = (() => {
      if (formFactor === 'short') {
        if (sourceIntent === 'longform') return 'short_cut_longform';
        return sourceMode === 'upload' ? 'short_enhance_upload' : 'short_fetch_enhance';
      }
      if (sourceIntent === 'longform') return 'long_produce_source';
      return 'long_compile_clips';
    })();

    const mergedConfig = { ...featureConfig };
    if (tone && features.has('script')) {
      mergedConfig.script = { ...(mergedConfig.script ?? {}), tone };
    }

    const payload: CreateJobPayload = {
      contentType:    pathToContentType(inferredPath),
      entryType:      (sourceMode === 'source' ? 'fetch' : 'upload') as 'fetch' | 'upload',
      platforms,
      formFactor,
      productionPath: inferredPath,
      features:       Array.from(features),
      extensions:     [],
      durationMins,
      publishMode:    'immediate',
      featureConfig:  Object.keys(mergedConfig).length ? mergedConfig : undefined,
    };

    if (sourceMode === 'source') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload as any).fetchSpec = {
        sourceUrls:    sourceItems.map((i) => i.url),
        stitchMode:    inferredMultiClip && sourceItems.length > 1,
        sourceLibrary: sourceItems.map((i) => ({
          url:          i.url,
          title:        i.title,
          duration:     i.duration,
          thumbnailUrl: i.thumbnailUrl,
          platform:     i.platform,
          contentType:  i.contentType || i.type,
        })),
      };
    } else {
      payload.uploadSpec = { fileKeys: fileKeys.split('\n').map((k) => k.trim()).filter(Boolean) };
    }

    if (scheduledStart === 'scheduled' && scheduledAt) {
      payload.scheduledStartAt = scheduledAt;
    }

    start(async () => {
      try {
        const token = await getToken();
        const res   = await createJob(payload, token ?? undefined);
        toast.success('Production started', {
          description: 'Your video is now building. Track progress on the job page.',
          duration: 5000,
        });
        if (res.jobId) router.push(`/myjobs/${res.jobId}`);
        else           router.push('/myjobs/active');
      } catch {
        setError("We couldn't create your job. Check your selections and try again.");
      }
    });
  }

  // ─── Section summaries ─────────────────────────────────────────────────────

  const summaries: Record<string, string> = {
    type: sourceIntent === 'longform'
      ? (formFactor === 'short' ? 'Cut clips from long-form' : 'Produce from source')
      : (inferredMultiClip ? 'Multi-clip stitch → long-form' : formFactor === 'short' ? 'Short clip / enhance' : ''),
    source: sourceMode === 'upload'
      ? (uploadedName ? `Upload: ${uploadedName}` : '')
      : sourceItems.length === 0 ? ''
        : sourceItems.length === 1
          ? `${sourceItems[0].title} · ${fmtSecs(sourceItems[0].duration ?? 0)}`
          : `${sourceItems.length} clips · ${fmtSecs(totalSecs)}`,
    format: format
      ? `${FORMATS.find((f) => f.id === format)?.label ?? format}${!isLongForm ? ` · ${durLabel(duration)}` : ''}`
      : '',
    platform: platforms.map((p) => PLATFORMS.find((x) => x.id === p)?.label ?? p).join(' · '),
    production: features.size === 0 ? 'Default pipeline'
      : Array.from(features).map((f) => FEATURES.find((x) => x.id === f)?.label ?? f).join(' · '),
    schedule: scheduledStart === 'now' ? 'Start now' : scheduledAt ? `Scheduled: ${scheduledAt}` : '',
  };

  // ─── Feature config panel ──────────────────────────────────────────────────

  function FeatureConfigPanel({ feat, cfg }: { feat: Feature; cfg: Record<string, string> }) {
    if (!feat.hasConfig) return null;
    return (
      <div className="px-3 pb-3 pt-2 border-t border-primary/10 bg-primary/[0.04] space-y-3">
        <p className="text-[11px] text-foreground/70 leading-relaxed italic border-l-2 border-primary/30 pl-2">
          {feat.outputImpact}
        </p>
        {feat.id === 'script' && (
          <>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Script tone</Label>
              <select value={tone} onChange={(e) => setTone(e.target.value)}
                className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="professional">Professional — clear, authoritative, on-brand</option>
                <option value="conversational">Conversational — natural, friendly, accessible</option>
                <option value="energetic">Energetic — fast-paced, punchy, high-impact</option>
                <option value="educational">Educational — structured, informative, step-by-step</option>
                <option value="dramatic">Dramatic — cinematic, emotional, story-driven</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Content brief <span className="normal-case font-normal text-muted-foreground/70">optional</span>
              </Label>
              <textarea value={cfg.brief ?? ''} onChange={(e) => setFeatureCfg('script', 'brief', e.target.value)}
                placeholder="e.g. Focus on the comeback story in Q4." rows={3}
                className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
            </div>
          </>
        )}
        {feat.id === 'tts' && (
          <>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Voice</Label>
              <select value={cfg.voiceId ?? 'JBFqnCBsd6RMkjVDRZzb'} onChange={(e) => setFeatureCfg('tts', 'voiceId', e.target.value)}
                className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="JBFqnCBsd6RMkjVDRZzb">George — deep, authoritative (default)</option>
                <option value="EXAVITQu4vr4xnSDxMaL">Bella — warm, professional female</option>
                <option value="ErXwobaYiN019PkySvjV">Antoni — natural, friendly male</option>
                <option value="MF3mGyEYCl7XYWbV9V6O">Elli — energetic, bright female</option>
                <option value="AZnzlk1XvdvUeBnXmlld">Domi — strong, clear male</option>
                <option value="pNInz6obpgDQGcFmaJgB">Adam — conversational, relatable</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Speaking speed</Label>
              <div className="flex items-center gap-3">
                <input type="range" min={0.7} max={1.3} step={0.1}
                  value={cfg.speed ?? '1.0'} onChange={(e) => setFeatureCfg('tts', 'speed', e.target.value)}
                  className="flex-1 accent-primary" />
                <span className="text-xs font-semibold tabular-nums w-10 text-right">{cfg.speed ?? '1.0'}×</span>
              </div>
            </div>
          </>
        )}
        {feat.id === 'commentary' && (
          <div className="space-y-1.5">
            <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Narration style</Label>
            <select value={cfg.style ?? 'commentary'} onChange={(e) => setFeatureCfg('commentary', 'style', e.target.value)}
              className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
              <option value="commentary">Commentary — live, reactive, play-by-play</option>
              <option value="documentary">Documentary — reflective, contextual, narrated</option>
              <option value="explainer">Explainer — clear, educational, structured</option>
              <option value="promotional">Promotional — persuasive, benefit-focused</option>
            </select>
          </div>
        )}
        {feat.id === 'generation' && (
          <>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Visual prompt <span className="normal-case font-normal text-muted-foreground/70">optional</span>
              </Label>
              <textarea value={cfg.prompt ?? ''} onChange={(e) => setFeatureCfg('generation', 'prompt', e.target.value)}
                placeholder="e.g. Wide establishing shot of a packed stadium at sunset" rows={2}
                className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Visual style</Label>
              <select value={cfg.visualStyle ?? 'cinematic'} onChange={(e) => setFeatureCfg('generation', 'visualStyle', e.target.value)}
                className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="cinematic">Cinematic — film-grade, dramatic lighting</option>
                <option value="documentary">Documentary — natural, handheld feel</option>
                <option value="clean">Clean — bright, modern, commercial</option>
                <option value="dynamic">Dynamic — fast cuts, high energy, sports</option>
              </select>
            </div>
          </>
        )}
        {feat.id === 'burn_images' && (
          <>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Image URLs</Label>
              <textarea value={cfg.imageUrls ?? ''} onChange={(e) => setFeatureCfg('burn_images', 'imageUrls', e.target.value)}
                placeholder="https://cdn.example.com/image.jpg" rows={2}
                className="w-full text-sm font-mono border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Position</Label>
                <select value={cfg.position ?? 'lower-third'} onChange={(e) => setFeatureCfg('burn_images', 'position', e.target.value)}
                  className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                  <option value="lower-third">Lower third</option>
                  <option value="full-frame">Full frame</option>
                  <option value="corner">Corner</option>
                  <option value="center">Center (title card)</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Duration (s)</Label>
                <input type="number" min={1} max={10} step={0.5}
                  value={cfg.durationSec ?? '3'} onChange={(e) => setFeatureCfg('burn_images', 'durationSec', e.target.value)}
                  className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  function FeatureRow({ feat }: { feat: Feature }) {
    const on       = features.has(feat.id);
    const cfg      = featureConfig[feat.id] ?? {};
    const depUnmet = feat.requires?.some((dep) => !features.has(dep)) ?? false;

    if (feat.minPlan && feat.minPlan !== 'operate' && feat.minPlan !== 'guided' && tier !== 'managed' && tier !== 'custom') {
      return (
        <LockedFeature minPlan={feat.minPlan} currentPlan={tier} label={feat.label}
          upgradeMsg={`${feat.label} is available on the Managed plan`}>
          <div className="rounded-lg border border-dashed border-border/60 opacity-50 p-3 flex items-center gap-3">
            <span className="w-4 h-4 rounded border border-muted-foreground/20 shrink-0" />
            <div>
              <p className="text-sm font-medium">{feat.label}</p>
              <p className="text-xs text-muted-foreground">{feat.description}</p>
            </div>
          </div>
        </LockedFeature>
      );
    }

    return (
      <div className={cn('rounded-lg border transition-all', on ? 'border-primary' : 'border-border')}>
        <button type="button" onClick={() => { if (depUnmet && !on) return; toggleFeature(feat.id); }}
          disabled={depUnmet && !on}
          className={cn('w-full flex items-center gap-3 p-3 text-left transition-colors',
            on ? 'bg-primary/5 rounded-t-lg' : 'hover:bg-muted/40 rounded-lg',
            depUnmet && !on && 'opacity-40 cursor-not-allowed')}>
          <span className={cn('w-4 h-4 rounded border shrink-0 flex items-center justify-center text-[10px] font-bold transition-colors',
            on ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30')}>
            {on ? '✓' : ''}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium leading-tight">{feat.label}</p>
              {depUnmet && !on && feat.requires && (
                <span className="text-[10px] text-muted-foreground border border-dashed border-muted-foreground/40 rounded px-1.5 py-0.5">
                  requires {feat.requires.map((r) => FEATURES.find((f) => f.id === r)?.label ?? r).join(' + ')}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{feat.description}</p>
          </div>
          {on && feat.hasConfig && <span className="text-[10px] text-primary font-medium shrink-0 opacity-60">configured ↓</span>}
        </button>
        {on && <FeatureConfigPanel feat={feat} cfg={cfg} />}
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl space-y-0">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-4">
        <div>
          <h1 className="text-2xl font-semibold">Create a video</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {templatePicked && templateId !== 'custom'
              ? `Using template: ${PRESET_TEMPLATES.find((t) => t.id === templateId)?.label ?? templateBanner ?? templateId}`
              : templatePicked ? 'Building from scratch — set each section below'
              : 'Pick a template to get started, or build your own'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={() => router.back()}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Cancel
          </button>
          <Button size="sm" disabled={!canSubmit || isPending} onClick={handleSubmit}>
            {isPending ? 'Starting…' : canSubmit ? 'Send to assembly →' : 'Fill required sections'}
          </Button>
        </div>
      </div>

      <Separator />

      <div className="flex items-start gap-6 pt-4">

        {/* ── Left: form ── */}
        <div className="flex-1 min-w-0 space-y-0">

          {/* Template picker or selected-template bar */}
          {!templatePicked ? (
            <div className="pb-4">
              <TemplateGrid
                selectedId={templateId}
                onApply={applyTemplate}
                onBuildMyOwn={pickBuildMyOwn}
                onChangeTemplate={changeTemplate}
              />
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border px-4 py-2.5 mb-4 bg-muted/20">
              {templateId === 'custom'
                ? <span className="text-sm font-medium">Building from scratch</span>
                : <>
                    <Badge variant="outline" className="border-primary/40 text-primary text-[11px]">
                      {PRESET_TEMPLATES.find((t) => t.id === templateId)?.label ?? templateBanner ?? 'Saved template'}
                    </Badge>
                    <span className="text-xs text-muted-foreground">Pre-configured — change any section below</span>
                  </>
              }
              <button type="button" onClick={changeTemplate}
                className="ml-auto text-[11px] text-primary hover:underline">
                ← Pick a different template
              </button>
            </div>
          )}

          {templatePicked && (
            <div className="space-y-1">

              {/* TYPE */}
              <CollapsibleSection id="type" label="Type" required
                summary={summaries.type} open={isOpen('type')} onToggle={() => toggle('type')}>
                <div className="space-y-3">
                  <ChipGroup
                    options={[
                      { id: 'short_clips',  label: 'Short clips',        sub: 'Enhance and assemble short-form clips' },
                      { id: 'long_compile', label: 'Compile long-form',  sub: 'Stitch short clips into a long video' },
                      { id: 'from_vod',     label: 'Cut from VOD',       sub: 'Extract clips from a long-form source' },
                      { id: 'produce_vod',  label: 'Produce from VOD',   sub: 'Script and narrate a long-form video' },
                    ]}
                    selected={[
                      sourceIntent === 'clips' && formFactor === 'short' ? 'short_clips' :
                      sourceIntent === 'clips' && formFactor === 'long'  ? 'long_compile' :
                      sourceIntent === 'longform' && formFactor === 'short' ? 'from_vod' :
                      sourceIntent === 'longform' && formFactor === 'long'  ? 'produce_vod' : '',
                    ].filter(Boolean)}
                    onToggle={(id) => {
                      const map: Record<string, [FormFactor, 'clips' | 'longform']> = {
                        short_clips:  ['short', 'clips'],
                        long_compile: ['long',  'clips'],
                        from_vod:     ['short', 'longform'],
                        produce_vod:  ['long',  'longform'],
                      };
                      const [ff, si] = map[id];
                      setFormFactor(ff);
                      setSourceIntent(si);
                      if (ff === 'long') { setFormat('longform'); setDuration('10min'); setDurationMins(10); }
                      else               { setFormat('portrait'); setDuration('60s');   setDurationMins(3); }
                      setSourceItems([]); setClipSpec(null); setShowClipEditor(false);
                    }}
                    singleSelect
                  />
                </div>
              </CollapsibleSection>

              <div className="h-px bg-border/50 my-0.5" />

              {/* SOURCE */}
              <CollapsibleSection id="source" label="Source clips" required
                summary={summaries.source} open={isOpen('source')} onToggle={() => toggle('source')}>
                <div className="space-y-4">
                  {/* Tab bar */}
                  <div className="flex gap-2">
                    {(['source', 'upload'] as SourceMode[]).map((s) => {
                      const labels: Record<SourceMode, string> = { source: 'Browse channels', upload: 'Upload file' };
                      return (
                        <button key={s} type="button" onClick={() => setSourceMode(s)}
                          className={cn('px-3 py-1.5 text-xs rounded-md border transition-colors',
                            sourceMode === s ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                          {labels[s]}
                        </button>
                      );
                    })}
                  </div>

                  {/* Browse */}
                  {sourceMode === 'source' && (
                    <div className="space-y-2">
                      <SourceLibraryPicker
                        maxSelect={10}
                        contentTypeFilter={sourceIntent === 'clips' ? 'clip' : sourceIntent === 'longform' ? 'vod' : undefined}
                        multiClipMode={inferredMultiClip}
                        onSelect={(items) => {
                          setSourceItems(items);
                          if (items.length > 0) setShowClipEditor(true);
                        }}
                        onClose={() => { setSourceItems([]); setShowClipEditor(false); }}
                      />
                      {sourceItems.length > 0 && (
                        <p className="text-xs text-primary font-medium">
                          ✓ {sourceItems.length} clip{sourceItems.length !== 1 ? 's' : ''} selected
                          {totalSecs > 0 ? ` · ${fmtSecs(totalSecs)} total` : ''}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Upload */}
                  {sourceMode === 'upload' && (
                    <VideoUpload
                      uploadedKey={uploadedKey}
                      uploadedName={uploadedName}
                      onUploaded={(key, name) => { setUploadedKey(key); setUploadedName(name); setFileKeys(key); }}
                      onClear={() => { setUploadedKey(null); setUploadedName(null); setFileKeys(''); }}
                    />
                  )}

                  {/* Clip Editor sub-panel */}
                  {showClipEditor && sourceItems.length > 0 && (
                    <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-primary">Clip editor</p>
                        <button type="button" onClick={() => setShowClipEditor(false)}
                          className="text-[10px] text-muted-foreground hover:underline">
                          Skip — let AuraFlux decide
                        </button>
                      </div>
                      <ClipEditor
                        mode={sourceIntent === 'longform' ? 'extract' : 'compact'}
                        sourceUrl={sourceIntent === 'longform' ? (sourceItems[0]?.url ?? undefined) : undefined}
                        sourceClips={sourceIntent !== 'longform'
                          ? sourceItems.map((i) => ({ url: i.url, title: i.title, duration: i.duration ?? undefined, thumbnailUrl: i.thumbnailUrl ?? undefined }))
                          : undefined}
                        availableFeatures={Array.from(features)}
                        onConfirm={(spec) => { setClipSpec(spec); setDurationMins(calcDuration(spec)); setShowClipEditor(false); }}
                        onCancel={() => { setClipSpec(null); setDurationMins(calcDuration(null)); setShowClipEditor(false); }}
                      />
                    </div>
                  )}
                </div>
              </CollapsibleSection>

              <div className="h-px bg-border/50 my-0.5" />

              {/* FORMAT */}
              <CollapsibleSection id="format" label="Format" required
                summary={summaries.format} open={isOpen('format')} onToggle={() => toggle('format')}>
                <div className="space-y-4">
                  <ChipGroup options={FORMATS} selected={[format]} singleSelect
                    onToggle={(id) => {
                      setFormat(id);
                      if (id === 'longform') { setFormFactor('long'); setDuration('10min'); setDurationMins(10); }
                      else if (formFactor === 'long') { setFormFactor('short'); setDuration('60s'); setDurationMins(3); }
                    }} />
                  <p className="text-[11px] text-muted-foreground">
                    9:16 works across all platforms — Shorts, TikTok, and Reels all use the same ratio
                  </p>
                  {!isLongForm && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium">Duration</p>
                      <ChipGroup options={DUR_SHORT} selected={[duration]} singleSelect
                        onToggle={(id) => { setDuration(id); setDurationMins(parseInt(id) / 60 || 1); }} />
                    </div>
                  )}
                </div>
              </CollapsibleSection>

              <div className="h-px bg-border/50 my-0.5" />

              {/* PLATFORM */}
              <CollapsibleSection id="platform" label="Platform" required
                summary={summaries.platform} open={isOpen('platform')} onToggle={() => toggle('platform')}>
                <ChipGroup options={PLATFORMS} selected={platforms}
                  onToggle={(id) => setPlatforms((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])} />
              </CollapsibleSection>

              <div className="h-px bg-border/50 my-0.5" />

              {/* PRODUCTION FEATURES */}
              <CollapsibleSection id="production" label="Production features"
                summary={summaries.production} open={isOpen('production')} onToggle={() => toggle('production')}>
                <div className="space-y-4">

                  {/* Captions + voiceover toggles */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Output options</p>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { id: 'captions',  label: 'Captions',   sub: 'Burned in from audio',    on: captions,  set: setCaptions },
                        { id: 'voiceover', label: 'Voice-over', sub: 'Script narration',         on: voiceover, set: setVoiceover },
                      ].map((opt) => (
                        <button key={opt.id} type="button" onClick={() => opt.set(!opt.on)}
                          className={cn('text-left rounded-lg border px-3 py-2 transition-colors min-w-[140px]',
                            opt.on ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:border-primary/40')}>
                          <p className="text-sm font-medium">{opt.label}</p>
                          <p className={cn('text-[11px] mt-0.5', opt.on ? 'text-primary-foreground/70' : 'text-muted-foreground')}>{opt.sub}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Color grade + effects */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Visual style</p>
                    <div className="flex gap-4 flex-wrap">
                      <div className="space-y-1.5">
                        <p className="text-[11px] text-muted-foreground">Color grade</p>
                        <ChipGroup options={GRADES} selected={[grade]} singleSelect onToggle={setGrade} />
                      </div>
                      <div className="space-y-1.5 flex-1 min-w-[200px]">
                        <p className="text-[11px] text-muted-foreground">Effects</p>
                        <ChipGroup options={EFFECTS_OPTS} selected={effects}
                          onToggle={(id) => setEffects((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])} />
                      </div>
                    </div>
                  </div>

                  {/* Audio */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Audio</p>
                    <ChipGroup options={AUDIO_OPTS} selected={audioOpts}
                      onToggle={(id) => setAudioOpts((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])} />
                  </div>

                  {/* Production features (existing) */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Production pipeline</p>
                    {CATEGORY_BOXES
                      .filter((box) => formFactor && box.formFactors.includes(formFactor))
                      .map((box) => {
                        const boxFeats = FEATURES.filter(
                          (f) => f.category === box.id && f.status === 'live' && formFactor && f.formFactors.includes(formFactor),
                        );
                        if (!boxFeats.length) return null;
                        const activeCount = boxFeats.filter((f) => features.has(f.id)).length;
                        const expanded    = expandedBoxes.has(box.id);
                        return (
                          <div key={box.id} className="rounded-lg border border-border overflow-hidden">
                            <button type="button"
                              onClick={() => setExpandedBoxes((prev) => {
                                const next = new Set(prev);
                                if (next.has(box.id)) next.delete(box.id); else next.add(box.id);
                                return next;
                              })}
                              className="w-full flex items-center justify-between px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left">
                              <div className="flex items-center gap-2">
                                <span className="text-base leading-none">{box.icon}</span>
                                <div>
                                  <p className="text-xs font-semibold">{box.label}</p>
                                  <p className="text-[10px] text-muted-foreground">{box.description}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {activeCount > 0 && (
                                  <span className="text-[10px] font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5">
                                    {activeCount} on
                                  </span>
                                )}
                                <span className="text-[11px] text-muted-foreground">{expanded ? '↑' : '↓'}</span>
                              </div>
                            </button>
                            {expanded && (
                              <div className="px-3 py-2 space-y-1.5 border-t border-border">
                                {boxFeats.map((feat) => <FeatureRow key={feat.id} feat={feat} />)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>

                  {/* Credit estimate */}
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">Credit estimate</span>
                      <span className="text-sm font-bold text-primary tabular-nums">{estimate.credits} credits</span>
                    </div>
                    <p className="text-xs text-foreground/80">{estimate.message}</p>
                  </div>
                </div>
              </CollapsibleSection>

              <div className="h-px bg-border/50 my-0.5" />

              {/* SCHEDULE */}
              <CollapsibleSection id="schedule" label="Scheduling"
                summary={summaries.schedule} open={isOpen('schedule')} onToggle={() => toggle('schedule')}>
                <div className="space-y-3">
                  <ChipGroup
                    options={[{ id: 'now', label: 'Start now' }, { id: 'scheduled', label: 'Schedule' }]}
                    selected={[scheduledStart]}
                    singleSelect
                    onToggle={(id) => setScheduledStart(id as 'now' | 'scheduled')}
                  />
                  {scheduledStart === 'scheduled' && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Production start time</Label>
                      <input
                        type="datetime-local"
                        value={scheduledAt}
                        min={new Date(Date.now() + 31 * 60 * 1000).toISOString().slice(0, 16)}
                        onChange={(e) => setScheduledAt(e.target.value)}
                        className="text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <p className="text-[10px] text-muted-foreground">Publish timing is set when you review the output</p>
                    </div>
                  )}
                </div>
              </CollapsibleSection>

            </div>
          )}

          {error && (
            <p className="mt-4 text-sm text-destructive bg-destructive/10 rounded px-3 py-2">
              {formatUserError(error)}
            </p>
          )}
        </div>

        {/* ── Right: sticky preview ── */}
        {templatePicked && (
          <div className="w-52 shrink-0 sticky top-4 space-y-4">
            <FramePreview
              clips={sourceItems}
              format={format}
              captions={captions}
              grade={grade as 'none' | 'warm' | 'cool' | 'neut'}
              effects={effects}
            />

            {/* Summary bullets */}
            {canSubmit && (
              <div className="space-y-1.5 border-t border-border pt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Summary</p>
                {[
                  FORMATS.find((f) => f.id === format)?.label,
                  !isLongForm && durLabel(duration),
                  platforms.map((p) => PLATFORMS.find((x) => x.id === p)?.label ?? p).join(' · '),
                  captions && 'Captions',
                  voiceover && 'Voice-over',
                  grade !== 'none' && `${grade.charAt(0).toUpperCase()}${grade.slice(1)} grade`,
                  effects.length > 0 && effects.map((e) => EFFECTS_OPTS.find((x) => x.id === e)?.label ?? e).join(', '),
                  features.size > 0 && `${features.size} feature${features.size !== 1 ? 's' : ''} enabled`,
                  `${estimate.credits} credits`,
                ].filter(Boolean).map((line, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <div className="w-1 h-1 rounded-full bg-primary shrink-0" />
                    <span>{String(line)}</span>
                  </div>
                ))}
              </div>
            )}

            <Button size="sm" className="w-full" disabled={!canSubmit || isPending} onClick={handleSubmit}>
              {isPending ? 'Starting…' : 'Send to assembly →'}
            </Button>
          </div>
        )}

      </div>
    </div>
  );
}

export default function NewJobPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Loading…</div>}>
      <JobBuilderPageInner />
    </Suspense>
  );
}
