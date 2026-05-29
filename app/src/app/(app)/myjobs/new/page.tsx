'use client';
/**
 * /myjobs/new — Job submission wizard (CPD-110, CPD-113)
 *
 * Platform-agnostic 4-step flow (CPD-303):
 *   1. Format        — Long-form (16:9) or Short-form (9:16)
 *   2. Source        — browse channel or upload file (production path inferred silently)
 *   3. Features      — production capabilities to apply
 *   4. Publish       — platform, schedule, add-on extensions
 *
 * CPD-113: AuraFlux Guide is integral to accuracy —
 *   • Guide auto-opens on mount with step-0 context
 *   • Context hint updates on every step change
 *   • Inline GuideTip card visible beneath each step's choices
 */

import { useState, useTransition, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { createJob, estimateCreditCost, getTemplateById, type CreateJobPayload } from '@/lib/api';
import { VideoUpload } from '@/components/upload/video-upload';
import { SchedulePicker, type ScheduleValue } from '@/components/jobs/schedule-picker';
import { JobTimingPicker, DEFAULT_JOB_TIMING, type JobTimingValue } from '@/components/jobs/job-timing-picker';
import { LockedFeature } from '@/components/ui/locked-feature';
import { SparkAnvil } from '@/components/icons/brand-icons';
import { useGuide } from '@/contexts/guide-context';
import { usePlan } from '@/contexts/plan-context';
import { SourceLibraryPicker } from '@/components/jobs/source-library-picker';
import { ClipEditor, type ClipSpec, type CompactClip, type ExtractClip } from '@/components/jobs/clip-editor';
import type { SourceItem } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

type PlanTier = 'operate' | 'guided' | 'managed' | 'custom';
type FormFactor = 'long' | 'short';

type ProductionPath =
  | 'long_compile_clips'
  | 'long_produce_source'
  | 'short_cut_longform'
  | 'short_enhance_upload'
  | 'short_fetch_enhance';

type SourceMode = 'upload' | 'fetch' | 'source';

interface Feature {
  id:          string;
  label:       string;
  description: string;
  tooltip:     string;
  outputImpact: string;
  default:     boolean;
  formFactors: ('long' | 'short')[];
  requires?:   string[];
  minPlan?:    PlanTier;
  hasConfig:   boolean;
  advanced?:   boolean;
  category:    'content' | 'editing' | 'effects' | 'brand';
  status:      'live' | 'sprint7' | 'sprint8';
}

interface FeatureGroup {
  id:          string;
  label:       string;
  description: string;
  featureIds:  string[];
  formFactors: ('long' | 'short')[];
}

interface CategoryBox {
  id:          'content' | 'editing' | 'effects' | 'brand';
  label:       string;
  description: string;
  icon:        string;
  formFactors: ('long' | 'short')[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PRODUCTION_PATHS: Record<FormFactor, { id: ProductionPath; label: string; description: string; sources: SourceMode[] }[]> = {
  long: [
    {
      id:          'long_compile_clips',
      label:       'Compile from short clips',
      description: 'Upload or fetch short-form clips — we assemble them into a finished long-form video',
      sources:     ['upload', 'fetch'],
    },
    {
      id:          'long_produce_source',
      label:       'Produce from source',
      description: 'Upload or fetch a long-form source — we script, narrate, and produce a finished video',
      sources:     ['upload', 'fetch'],
    },
  ],
  short: [
    {
      id:          'short_cut_longform',
      label:       'Cut clips from long-form',
      description: 'Upload a long-form video — we extract the best short clips with design and captions',
      sources:     ['upload'],
    },
    {
      id:          'short_enhance_upload',
      label:       'Enhance uploaded clips',
      description: 'Upload your short clips — we add branding, captions, overlays, and design specs',
      sources:     ['upload'],
    },
    {
      id:          'short_fetch_enhance',
      label:       'Fetch and enhance',
      description: 'Give us URLs — we fetch the content and apply your design specs',
      sources:     ['fetch'],
    },
  ],
};

const FEATURES: Feature[] = [
  // ── Content & Script ──────────────────────────────────────────────────────
  {
    id: 'script', label: 'Write my script',
    description: 'AI writes the video script from your source material',
    tooltip: 'Gemini analyses your source and writes a structured script — intro, key segments, and a close — matched to your tone.',
    outputImpact: 'Your video gets a structured script — intro, key segments, and a close — written to your tone.',
    default: true, formFactors: ['long'], hasConfig: true,
    category: 'content', status: 'live',
  },
  {
    id: 'tts', label: 'AI voiceover',
    description: 'AI voice narrates the generated script',
    tooltip: 'A professional AI voice reads your script in the video — no recording studio needed.',
    outputImpact: 'A professional voice reads your script in the video — no separate recording needed.',
    default: false, formFactors: ['long'], requires: ['script'], hasConfig: true, advanced: true,
    category: 'content', status: 'live',
  },
  {
    id: 'commentary', label: 'Commentary style',
    description: 'Narrative text commentary timed to footage',
    tooltip: 'Choose a commentary style and tone — dry, hype, educational. Text overlays appear timed to key moments.',
    outputImpact: 'Commentary text appears timed to key moments — styled as captions or lower thirds.',
    default: false, formFactors: ['long'], hasConfig: true, advanced: true,
    category: 'content', status: 'live',
  },
  {
    id: 'generation', label: 'Video generation',
    description: 'AI-generated clips fill missing footage',
    tooltip: 'Where source footage is missing, AI generates clips matching your topic and style.',
    outputImpact: 'Gaps in your footage are filled with generated video clips that match your topic and style.',
    default: false, formFactors: ['long'], hasConfig: true, advanced: true,
    category: 'content', status: 'live',
  },
  // ── Editing & Pacing ──────────────────────────────────────────────────────
  {
    id: 'scene_select', label: 'Smart clip selection',
    description: 'AI picks the best clips from your source',
    tooltip: 'Only the most relevant and energetic segments from your source are used — weak clips are cut automatically.',
    outputImpact: 'Only the most relevant segments from your source are used — weak clips are cut automatically.',
    default: true, formFactors: ['long', 'short'], hasConfig: false,
    category: 'editing', status: 'live',
  },
  {
    id: 'burn_images', label: 'Image segments',
    description: 'Embed still images as overlay segments',
    tooltip: 'Embed your images as timed segments in the assembled video — useful for cover art, infographics, or intro slides.',
    outputImpact: 'Your images appear in the video at the position and duration you specify.',
    default: false, formFactors: ['long', 'short'], hasConfig: true, advanced: true,
    category: 'editing', status: 'live',
  },
  // ── Effects & Audio ────────────────────────────────────────────────────────
  {
    id: 'dynamic', label: 'Animated overlays',
    description: 'Animated text, scoreboards, and motion graphics',
    tooltip: 'Live data overlays — scores, stats, headlines — animated in your brand style at key moments.',
    outputImpact: 'Live data overlays (scores, stats, headlines) are animated into the video using your brand style.',
    default: false, formFactors: ['long', 'short'], hasConfig: false,
    category: 'effects', status: 'live',
  },
  // ── Design & Brand ─────────────────────────────────────────────────────────
  {
    id: 'branding', label: 'Branded intro/outro',
    description: 'Apply your brand config across the video',
    tooltip: 'Your logo, colour palette, and branded intro/outro are applied consistently across the assembled video.',
    outputImpact: 'Your brand logo, colour palette, and lower-third templates are applied across the assembled video.',
    default: true, formFactors: ['long', 'short'], hasConfig: false,
    category: 'brand', status: 'live',
  },
];

// 4 category boxes for Step 2 feature selection (CPD-420)
const CATEGORY_BOXES: CategoryBox[] = [
  {
    id: 'content',
    label: 'Content & Script',
    description: 'Write, voice, and narrate your video',
    icon: '✍️',
    formFactors: ['long'],
  },
  {
    id: 'editing',
    label: 'Editing & Pacing',
    description: 'Smart cuts, clip selection, and timing',
    icon: '✂️',
    formFactors: ['long', 'short'],
  },
  {
    id: 'effects',
    label: 'Effects & Audio',
    description: 'Overlays, animations, and sound',
    icon: '✨',
    formFactors: ['long', 'short'],
  },
  {
    id: 'brand',
    label: 'Design & Brand',
    description: 'Thumbnails, intros, and brand identity',
    icon: '🎨',
    formFactors: ['long', 'short'],
  },
];

// Feature groups — legacy, kept for backward compat with any code that reads FEATURE_GROUPS
const FEATURE_GROUPS: FeatureGroup[] = [
  {
    id: 'scripting', label: 'Scripting & narration',
    description: 'Write, voice, and narrate your video',
    featureIds: ['script', 'tts', 'commentary'],
    formFactors: ['long'],
  },
  {
    id: 'visual', label: 'Visual production',
    description: 'Generate and source footage',
    featureIds: ['generation', 'burn_images'],
    formFactors: ['long', 'short'],
  },
  {
    id: 'assembly', label: 'Editing & finishing',
    description: 'Cut, brand, and animate',
    featureIds: ['scene_select', 'branding', 'dynamic'],
    formFactors: ['long', 'short'],
  },
];

// Plan-based feature defaults — higher tiers get richer pipelines on by default
const PLAN_DEFAULTS: Record<string, Record<FormFactor, string[]>> = {
  operate:  { long: ['script', 'scene_select', 'branding'],                                          short: ['scene_select', 'branding'] },
  guided:   { long: ['script', 'scene_select', 'branding'],                                          short: ['scene_select', 'branding', 'dynamic'] },
  managed:  { long: ['script', 'commentary', 'generation', 'scene_select', 'branding', 'dynamic'],  short: ['scene_select', 'branding', 'dynamic'] },
  custom:   { long: ['script', 'commentary', 'generation', 'scene_select', 'branding', 'dynamic'],  short: ['scene_select', 'branding', 'dynamic'] },
};

const ADD_ONS = [
  { id: 'shoppable', label: 'Shoppable tagging', description: 'Product tags embedded for social commerce', badge: 'Managed', minPlan: 'managed' as const },
];

const PLATFORMS = [
  { id: 'youtube',   label: 'YouTube',   minPlan: undefined },
  { id: 'tiktok',    label: 'TikTok',    minPlan: 'managed' as const },
  { id: 'instagram', label: 'Instagram', minPlan: undefined },
];

const PLATFORM_LABEL: Record<string, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
};

// ─── Guide content ────────────────────────────────────────────────────────────
// Inline tip shown beneath step choices + context hint sent to the guide panel.

interface GuideContent {
  tip:     string;
  hint:    string; // sent to the guide panel context banner
}

const STEP_GUIDE: Record<number, GuideContent> = {
  0: {
    tip:  'Format determines the entire pipeline. Long-form (16:9) is best for compilations, full episodes, and commentary. Short-form (9:16) is built for TikTok, Reels, and YouTube Shorts.',
    hint: 'Step 1 of 4 — Format. Ask me which format works best for your content type.',
  },
  1: {
    tip:  'Browse your Twitch, YouTube, or Kick channel to pick clips directly — or upload your own files. The production path is set automatically based on what you provide.',
    hint: 'Step 2 of 4 — Source. Ask me how browsing works, what file formats are supported, or how clips are processed.',
  },
  2: {
    tip:  'Script + TTS together give you a fully narrated video. Scene selection is key for sports and compilations. Captions, branding, and overlays are applied at assembly.',
    hint: 'Step 3 of 4 — Features. I can explain what each feature does, how they interact, and how they affect credits.',
  },
  3: {
    tip:  'Schedule at least 30 minutes out to allow production time. Platforms you select determine where we publish your video.',
    hint: 'Step 4 of 4 — Publish. Ask me about platform requirements, scheduling, or credit costs.',
  },
};

// ─── Components ───────────────────────────────────────────────────────────────

function GuideTip({ step }: { step: number }) {
  const guide = useGuide();
  const content = STEP_GUIDE[step];
  if (!content) return null;

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary shrink-0">
          <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
        </svg>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">Tip</span>
        <button
          type="button"
          onClick={() => guide.openWithContext(content.hint)}
          className="ml-auto text-[10px] text-primary hover:underline"
        >
          Ask a question →
        </button>
      </div>
      <p className="text-xs text-foreground/80 leading-relaxed">{content.tip}</p>
    </div>
  );
}

const STEPS = ['Format', 'Source', 'Features', 'Publish'] as const;
type Step = 0 | 1 | 2 | 3;

function StepHeader({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center">
          <div className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors',
            // P0-2: Math.floor handles step 1.5 — Source stays highlighted during editor step
            Math.floor(step) === i  ? 'bg-primary text-primary-foreground font-medium'
              : i < step  ? 'text-muted-foreground'
              : 'text-muted-foreground/40',
          )}>
            <span className={cn(
              'w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-semibold border',
              Math.floor(step) === i  ? 'border-primary-foreground/30 bg-primary-foreground/10'
                : i < step ? 'border-muted-foreground/30' : 'border-muted-foreground/20',
            )}>{i + 1}</span>
            {label}
          </div>
          {i < STEPS.length - 1 && (
            <div className={cn('w-4 h-px mx-0.5', i < step ? 'bg-muted-foreground/30' : 'bg-muted-foreground/15')} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

function NewJobPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const { getToken } = useAuth();
  const [isPending, start] = useTransition();

  const [step, setStep] = useState<Step>(0 as Step);
  const [error, setError] = useState<string | null>(null);
  const [templateBanner, setTemplateBanner] = useState<string | null>(null);

  const { openWithContext, setContextHint } = useGuide();
  const { planTier } = usePlan();

  // Wizard state
  const [formFactor, setFormFactor] = useState<FormFactor | null>(null);
  const [sourceIntent, setSourceIntent] = useState<'clips' | 'longform' | null>(null);
  const [sourceMode, setSourceMode]       = useState<SourceMode | null>(null);
  const [sourceUrls, setSourceUrls]       = useState('');
  const [sourceItems, setSourceItems]     = useState<SourceItem[]>([]);
  const [fileKeys,    setFileKeys]         = useState('');
  const [uploadedKey, setUploadedKey]     = useState<string | null>(null);
  const [uploadedName,setUploadedName]    = useState<string | null>(null);
  const [topic, setTopic]           = useState('');
  const [tone, setTone]             = useState('professional');
  const [features, setFeatures]     = useState<Set<string>>(new Set());
  const [featureConfig, setFeatureConfig] = useState<Record<string, Record<string, string>>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expandedBoxes, setExpandedBoxes] = useState<Set<string>>(new Set(['content', 'editing', 'brand']));
  function setFeatureCfg(featureId: string, key: string, value: string) {
    setFeatureConfig((prev) => ({
      ...prev,
      [featureId]: { ...(prev[featureId] ?? {}), [key]: value },
    }));
  }
  const [platforms, setPlatforms]   = useState<string[]>(['youtube']);
  const [addOns, setAddOns]         = useState<Set<string>>(new Set());
  const [jobTiming, setJobTiming]     = useState<JobTimingValue>(DEFAULT_JOB_TIMING);
  // CPD-115: duration — auto-calculated from clip editor output, not manually entered
  const [durationMins, setDurationMins] = useState<number>(3);
  const [clipSpec, setClipSpec]         = useState<ClipSpec | null>(null);

  // CPD-125: pre-fill from template if ?templateId= is present
  useEffect(() => {
    const templateId = searchParams.get('templateId');
    if (!templateId) return;
    (async () => {
      try {
        const token = await getToken();
        const { template } = await getTemplateById(templateId, token ?? undefined);
        const spec = template.jobSpec as Record<string, unknown>;
        // Apply template fields to wizard state
        if (template.platforms?.length) setPlatforms(template.platforms);
        const ff = (spec.formFactor as FormFactor) || null;
        if (ff) setFormFactor(ff);
        const feats = spec.features as string[] | undefined;
        if (feats?.length) setFeatures(new Set(feats));
        const ao = spec.addOns as string[] | undefined;
        if (ao?.length) setAddOns(new Set(ao));
        const dur = spec.durationMins as number | undefined;
        if (dur) setDurationMins(dur);
        setTemplateBanner(template.name);
        // Advance past format step if formFactor is set
        if (ff) setStep(1);
      } catch { /* template not found — silent */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // CPD-113: Auto-open guide on mount with step-0 context
  useEffect(() => {
    openWithContext(STEP_GUIDE[0].hint);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Credit estimate — computed at component level so both Step 2 and Step 3 checkout can read it.
  // Uses sourceMode directly to avoid forward-reference to effectiveSource.
  const estimate = estimateCreditCost({
    durationMins,
    features: Array.from(features),
    extensions: Array.from(addOns),
    sourceMode: (sourceMode ?? 'source') as string,
    planTier: planTier ?? 'operate',
  });

  // CPD-113: Update guide context hint whenever the step changes
  useEffect(() => {
    setContextHint(STEP_GUIDE[step]?.hint ?? null);
  }, [step, setContextHint]);


  function toggleFeature(id: string) {
    setFeatures((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function togglePlatform(id: string) {
    setPlatforms((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]);
  }
  function toggleAddOn(id: string) {
    setAddOns((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function advance() {
    setError(null);
    if (step === 0 && !formFactor) { setError('Select a format to continue'); return; }
    if (step === 1) {
      if (!sourceIntent) { setError('Select a content transformation type to continue'); return; }
      // Source is now always 'source' (browse) or 'upload'; 'fetch' (paste URLs) is hidden
      const mode = effectiveSource;
      if (mode === 'fetch') {
        if (!sourceUrls.split('\n').map((u) => u.trim()).filter(Boolean).length) {
          setError('Enter at least one URL'); return;
        }
      } else if (mode === 'source') {
        if (!sourceItems.length) {
          setError('Select at least one clip from the Source Library'); return;
        }
        // Route to clip editor — duration will be calculated from confirmed clips
        setStep(1.5 as Step);
        return;
      } else {
        if (!fileKeys.trim()) {
          setError('Please upload a video file before continuing'); return;
        }
      }
    }
    if (step === 3) {
      if (jobTiming.productionStart.mode === 'scheduled' && !jobTiming.productionStart.scheduledStartAt) {
        setError('Choose a production start date and time, or switch to Start now.');
        return;
      }
      if (jobTiming.recurrence.enabled && !jobTiming.recurrence.templateName.trim()) {
        setError('Enter a template name for the recurring schedule.');
        return;
      }
      handleSubmit();
      return;
    }
    setStep((s) => (s + 1) as Step);
  }

  async function handleSubmit() {
    setError(null);
    const mode = effectiveSource;

    // Infer production path from output format + source content type (clips vs long-form)
    const inferredPath: ProductionPath = (() => {
      if (formFactor === 'short') {
        if (sourceIntent === 'longform') return 'short_cut_longform'; // long video → cut into clips
        return mode === 'upload' ? 'short_enhance_upload' : 'short_fetch_enhance'; // clips → enhance
      }
      // Long-form output
      if (sourceIntent === 'longform') return 'long_produce_source'; // long video → produce/enhance
      return 'long_compile_clips'; // clips → compile into long form
    })();

    // Merge tone into featureConfig.script so it travels with the feature
    const mergedConfig = { ...featureConfig };
    if (tone && features.has('script')) {
      mergedConfig.script = { ...(mergedConfig.script ?? {}), tone };
    }

    const payload: CreateJobPayload = {
      contentType:    pathToContentType(inferredPath),
      entryType:      (mode === 'source' ? 'fetch' : mode) as 'fetch' | 'upload' | 'create',
      platforms,
      formFactor,
      productionPath: inferredPath,
      features:       Array.from(features),
      extensions:     Array.from(addOns),
      durationMins,
      publishMode:    jobTiming.publish.publishMode,
      topic:          topic.trim() || undefined,
      tone:           tone || undefined,
      featureConfig:  Object.keys(mergedConfig).length ? mergedConfig : undefined,
    };

    if (mode === 'fetch') {
      payload.fetchSpec = { sourceUrls: sourceUrls.split('\n').map((u) => u.trim()).filter(Boolean) };
    } else if (mode === 'source') {
      // Source Library: pass URLs as fetchSpec + enrich with titles/thumbnails
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload as any).fetchSpec = {
        sourceUrls: sourceItems.map((i) => i.url),
        sourceLibrary: sourceItems.map((i) => ({
          url:          i.url,
          title:        i.title,
          duration:     i.duration,
          thumbnailUrl: i.thumbnailUrl,
          platform:     i.platform,
          contentType:  i.contentType || i.type,
        })),
      };
      // entryType already set to 'fetch' in payload initializer above
    } else {
      payload.uploadSpec = { fileKeys: fileKeys.split('\n').map((k) => k.trim()).filter(Boolean) };
    }

    if (jobTiming.publish.publishMode === 'scheduled' && jobTiming.publish.scheduledPublishAt) {
      payload.scheduledPublishAt = jobTiming.publish.scheduledPublishAt;
    }

    if (jobTiming.productionStart.mode === 'scheduled' && jobTiming.productionStart.scheduledStartAt) {
      payload.scheduledStartAt = jobTiming.productionStart.scheduledStartAt;
    }

    if (jobTiming.recurrence.enabled) {
      payload.recurringTemplate = {
        name: jobTiming.recurrence.templateName.trim(),
        recurrenceType: jobTiming.recurrence.recurrenceType,
        recurrenceDay: jobTiming.recurrence.recurrenceDay,
        recurrenceTime: jobTiming.recurrence.recurrenceTime,
      };
    }

    start(async () => {
      try {
        const token = await getToken();
        const res = await createJob(payload, token ?? undefined);
        console.info('[new-job] created', res.jobId ?? res.templateId, res.status);
        toast.success('Production started', {
          description: 'Your video is now building. Track progress on the job page.',
          duration: 5000,
        });
        if (res.jobId) {
          router.push(`/myjobs/${res.jobId}`);
        } else {
          router.push('/myjobs/active');
        }
      } catch (err: unknown) {
        setError("We couldn't create your job. Check your selections and try again.");
      }
    });
  }

  // Source is always browse-channel-or-upload — path is inferred at submit time
  const effectiveSource    = (sourceMode ?? 'source') as SourceMode;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New job</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Configure your content production job</p>
      </div>

      {templateBanner && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
          <span>Using template: <strong>{templateBanner}</strong></span>
          <button
            type="button"
            onClick={() => setTemplateBanner(null)}
            className="text-xs text-muted-foreground hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      <StepHeader step={step} />

      <Separator />

      {/* Step 0 — Format */}
      {step === 0 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">What format do you want to produce?</p>
          <div className="grid grid-cols-2 gap-3">
            {([
              { id: 'long',  label: 'Long-form',  sub: '16:9 landscape — YouTube, full episodes, compilations' },
              { id: 'short', label: 'Short-form',  sub: '9:16 portrait — TikTok, Reels, YouTube Shorts' },
            ] as { id: FormFactor; label: string; sub: string }[]).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setFormFactor(opt.id);
                  setSourceIntent(null);
                  setSourceMode(null);
                  // Seed defaults from plan tier — higher tiers get richer pipelines on by default
                  const tier = planTier ?? 'operate';
                }}
                className={cn(
                  'text-left p-4 rounded-lg border transition-colors space-y-1',
                  formFactor === opt.id ? 'border-primary bg-primary/5' : 'border-border hover:border-border/80',
                )}
              >
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground">{opt.sub}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 1 — Source */}
      {step === 1 && (
        <div className="space-y-6">
          {/* Source content type — determines production path */}
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold">What type of content transformation would you like?</p>
              <p className="text-xs text-muted-foreground mt-1">
                This determines what we pull from your channels or file — make sure to select before browsing.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {([
                {
                  id:    'clips'    as const,
                  label: formFactor === 'long' ? 'Short clips' : 'Short clips / footage',
                  sub:   formFactor === 'long'
                    ? 'We\'ll compile your clips into a long-form video'
                    : 'We\'ll enhance and assemble your clips into a short-form video',
                },
                {
                  id:    'longform' as const,
                  label: 'Long-form video / VOD',
                  sub:   formFactor === 'long'
                    ? 'We\'ll produce and enhance your long-form content'
                    : 'We\'ll cut clips from your long video',
                },
              ]).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSourceIntent(opt.id)}
                  className={cn(
                    'text-left p-4 rounded-lg border-2 transition-colors space-y-1 min-h-[88px]',
                    sourceIntent === opt.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/40',
                  )}
                >
                  <p className="text-sm font-semibold">{opt.label}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{opt.sub}</p>
                </button>
              ))}
            </div>
            {!sourceIntent && (
              <p className="text-xs text-amber-500/80 font-medium">↑ Step 1: choose content type above, then select your source below.</p>
            )}
          </div>

          {/* Source mode tabs — disabled until content type is chosen (CPD-341) */}
          <div className="flex gap-2">
            {(['source', 'upload'] as SourceMode[]).map((s) => {
              const labels: Record<SourceMode, string> = { source: 'Browse my channels', upload: 'Upload files', fetch: 'Paste URLs' };
              return (
                <button
                  key={s}
                  type="button"
                  disabled={!sourceIntent}
                  title={!sourceIntent ? 'Select a content type above first' : undefined}
                  onClick={() => {
                    setSourceMode(s);
                    if (s !== 'source') setSourceItems([]);
                    if (s !== 'fetch')  setSourceUrls('');
                    if (s !== 'upload') { setUploadedKey(null); setUploadedName(null); setFileKeys(''); }
                  }}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-md border transition-colors',
                    effectiveSource === s
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                    !sourceIntent && 'opacity-40 cursor-not-allowed',
                  )}
                >
                  {labels[s]}
                </button>
              );
            })}
          </div>

          {effectiveSource === 'fetch' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Source URLs <span className="text-muted-foreground">(one per line)</span></Label>
              <Textarea
                value={sourceUrls}
                onChange={(e) => setSourceUrls(e.target.value)}
                placeholder="https://..."
                className="min-h-[100px] text-sm font-mono"
              />
            </div>
          )}

          {effectiveSource === 'source' && (
            <div className="space-y-1.5">
              <SourceLibraryPicker
                maxSelect={10}
                contentTypeFilter={sourceIntent === 'clips' ? 'clip' : sourceIntent === 'longform' ? 'vod' : undefined}
                onSelect={(items) => {
                  setSourceItems(items);
                }}
                onClose={() => {
                  setSourceItems([]);
                  setSourceMode('fetch');
                }}
              />
              {sourceItems.length > 0 && (
                <p className="text-xs text-primary font-medium">
                  ✓ {sourceItems.length} clip{sourceItems.length !== 1 ? 's' : ''} selected — ready for next step
                </p>
              )}
            </div>
          )}

          {effectiveSource === 'upload' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Your video file</Label>
              <VideoUpload
                uploadedKey={uploadedKey}
                uploadedName={uploadedName}
                onUploaded={(key, name) => {
                  setUploadedKey(key);
                  setUploadedName(name);
                  setFileKeys(key);
                }}
                onClear={() => {
                  setUploadedKey(null);
                  setUploadedName(null);
                  setFileKeys('');
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Step 1.5 — Clip editor (source-browse path only) */}
      {(step as number) === 1.5 && (() => {
        const editorMode = sourceIntent === 'longform' ? 'extract' : 'compact';

        function calcDuration(spec: ClipSpec | null): number {
          if (!spec) {
            // "Let AuraFlux decide" — estimate from raw source items
            const totalSec = sourceItems.reduce((sum, i) => sum + (i.duration ?? 0), 0);
            const factor   = sourceIntent === 'longform' ? 0.15 : 0.70;
            return Math.max(1, Math.min(15, Math.round((totalSec * factor) / 60)));
          }
          let totalSec = 0;
          if (spec.mode === 'compact') {
            (spec.clips as CompactClip[]).forEach((c) => {
              totalSec += (c.trimEnd ?? c.durationHint ?? 0) - c.trimStart;
            });
          } else {
            (spec.clips as ExtractClip[]).forEach((c) => {
              totalSec += c.endTime - c.startTime;
            });
          }
          return Math.max(1, Math.min(15, Math.round(totalSec / 60)));
        }

        return (
          <ClipEditor
            mode={editorMode}
            sourceUrl={editorMode === 'extract' ? (sourceItems[0]?.url ?? undefined) : undefined}
            sourceClips={editorMode === 'compact'
              ? sourceItems.map((i) => ({
                  url:          i.url,
                  title:        i.title,
                  duration:     i.duration ?? undefined,
                  thumbnailUrl: i.thumbnailUrl ?? undefined,
                }))
              : undefined}
            availableFeatures={[]}
            onConfirm={(spec) => {
              setClipSpec(spec);
              setDurationMins(calcDuration(spec));
              setStep(2 as Step);
            }}
            onCancel={() => {
              setClipSpec(null);
              setDurationMins(calcDuration(null));
              setStep(2 as Step);
            }}
          />
        );
      })()}

      {/* Step 2 — Features & configuration */}
      {step === 2 && (() => {
        const tier = planTier ?? 'operate';

        // Helper: render inline config panel for a feature
        function FeatureConfigPanel({ feat, cfg }: { feat: Feature; cfg: Record<string, string> }) {
          if (!feat.hasConfig) return null;
          return (
            <div className="px-3 pb-3 pt-2 border-t border-primary/10 bg-primary/[0.04] space-y-3">
              {/* Output impact line */}
              <p className="text-[11px] text-foreground/70 leading-relaxed italic border-l-2 border-primary/30 pl-2">
                {feat.outputImpact}
              </p>

              {feat.id === 'script' && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Script tone</Label>
                    <select
                      value={tone}
                      onChange={(e) => setTone(e.target.value)}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="professional">Professional — clear, authoritative, on-brand</option>
                      <option value="conversational">Conversational — natural, friendly, accessible</option>
                      <option value="energetic">Energetic — fast-paced, punchy, high-impact</option>
                      <option value="educational">Educational — structured, informative, step-by-step</option>
                      <option value="dramatic">Dramatic — cinematic, emotional, story-driven</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                      Content brief{' '}
                      <span className="normal-case font-normal text-muted-foreground/70">optional — key angles, stats, context for script gen</span>
                    </Label>
                    <textarea
                      value={cfg.brief ?? ''}
                      onChange={(e) => setFeatureCfg('script', 'brief', e.target.value)}
                      placeholder="e.g. Focus on the comeback story in Q4. Include player stats for Johnson and Moore. Lead with the highlight reel."
                      rows={3}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                    <p className="text-[10px] text-muted-foreground">{(cfg.brief ?? '').length}/500 chars</p>
                  </div>
                </>
              )}

              {feat.id === 'tts' && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Voice</Label>
                    <select
                      value={cfg.voiceId ?? 'JBFqnCBsd6RMkjVDRZzb'}
                      onChange={(e) => setFeatureCfg('tts', 'voiceId', e.target.value)}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    >
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
                      <input
                        type="range" min={0.7} max={1.3} step={0.1}
                        value={cfg.speed ?? '1.0'}
                        onChange={(e) => setFeatureCfg('tts', 'speed', e.target.value)}
                        className="flex-1 accent-primary"
                      />
                      <span className="text-xs font-semibold tabular-nums w-10 text-right">{cfg.speed ?? '1.0'}×</span>
                    </div>
                    <div className="flex justify-between text-[10px] text-muted-foreground"><span>Slower</span><span>Normal</span><span>Faster</span></div>
                  </div>
                </>
              )}

              {feat.id === 'commentary' && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Narration style</Label>
                    <select
                      value={cfg.style ?? 'commentary'}
                      onChange={(e) => setFeatureCfg('commentary', 'style', e.target.value)}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="commentary">Commentary — live, reactive, play-by-play</option>
                      <option value="documentary">Documentary — reflective, contextual, narrated</option>
                      <option value="explainer">Explainer — clear, educational, structured</option>
                      <option value="promotional">Promotional — persuasive, benefit-focused</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                      Narration notes <span className="normal-case font-normal text-muted-foreground/70">optional</span>
                    </Label>
                    <textarea
                      value={cfg.notes ?? ''}
                      onChange={(e) => setFeatureCfg('commentary', 'notes', e.target.value)}
                      placeholder="e.g. Focus on emotional moments. Mention the crowd reaction. Keep segments under 20 words."
                      rows={2}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                  </div>
                </>
              )}

              {feat.id === 'generation' && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                      Visual prompt <span className="normal-case font-normal text-muted-foreground/70">optional — auto-generated from topic if blank</span>
                    </Label>
                    <textarea
                      value={cfg.prompt ?? ''}
                      onChange={(e) => setFeatureCfg(feat.id, 'prompt', e.target.value)}
                      placeholder="e.g. Wide establishing shot of a packed stadium at sunset, crowd cheering, cinematic lens flare"
                      rows={3}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Visual style</Label>
                    <select
                      value={cfg.visualStyle ?? 'cinematic'}
                      onChange={(e) => setFeatureCfg(feat.id, 'visualStyle', e.target.value)}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    >
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
                    <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                      Image URLs <span className="normal-case font-normal text-muted-foreground/70">one per line — direct .jpg .png .webp links</span>
                    </Label>
                    <textarea
                      value={cfg.imageUrls ?? ''}
                      onChange={(e) => setFeatureCfg('burn_images', 'imageUrls', e.target.value)}
                      placeholder={'https://cdn.example.com/image1.jpg\nhttps://cdn.example.com/image2.png'}
                      rows={3}
                      className="w-full text-sm font-mono border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Position</Label>
                      <select
                        value={cfg.position ?? 'lower-third'}
                        onChange={(e) => setFeatureCfg('burn_images', 'position', e.target.value)}
                        className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="lower-third">Lower third</option>
                        <option value="full-frame">Full frame</option>
                        <option value="corner">Corner</option>
                        <option value="center">Center (title card)</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Duration (s)</Label>
                      <input
                        type="number" min={1} max={10} step={0.5}
                        value={cfg.durationSec ?? '3'}
                        onChange={(e) => setFeatureCfg('burn_images', 'durationSec', e.target.value)}
                        className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        }

        // Render a single feature row (used inside each group)
        function FeatureRow({ feat }: { feat: Feature }) {
          const on   = features.has(feat.id);
          const cfg  = featureConfig[feat.id] ?? {};
          const depUnmet = feat.requires?.some((dep) => !features.has(dep)) ?? false;

          // Managed-only feature — wrap with LockedFeature
          if (feat.minPlan && feat.minPlan !== 'operate' && feat.minPlan !== 'guided' && tier !== 'managed' && tier !== 'custom') {
            return (
              <LockedFeature
                minPlan={feat.minPlan}
                currentPlan={tier as 'operate' | 'guided' | 'managed' | 'custom'}
                label={feat.label}
                upgradeMsg={`${feat.label} is available on the Managed plan`}
              >
                <div className="rounded-lg border border-dashed border-border/60 opacity-50">
                  <div className="flex items-center gap-3 p-3">
                    <span className="w-4 h-4 rounded border border-muted-foreground/20 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium leading-tight">{feat.label}</p>
                        <Badge variant="outline" className="text-[9px] h-4 px-1.5 font-medium">Managed</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{feat.description}</p>
                    </div>
                  </div>
                </div>
              </LockedFeature>
            );
          }

          return (
            <div className={cn('rounded-lg border transition-all', on ? 'border-primary' : 'border-border')}>
              <button
                type="button"
                onClick={() => {
                  if (depUnmet && !on) return; // block enable if dependency not met
                  toggleFeature(feat.id);
                }}
                disabled={depUnmet && !on}
                className={cn(
                  'w-full flex items-center gap-3 p-3 text-left transition-colors',
                  on ? 'bg-primary/5 rounded-t-lg' : 'hover:bg-muted/40 rounded-lg',
                  depUnmet && !on && 'opacity-40 cursor-not-allowed',
                )}
              >
                <span className={cn(
                  'w-4 h-4 rounded border shrink-0 flex items-center justify-center text-[10px] font-bold transition-colors',
                  on ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30',
                )}>
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
                {on && feat.hasConfig && (
                  <span className="text-[10px] text-primary font-medium shrink-0 opacity-60">configured ↓</span>
                )}
              </button>
              {on && <FeatureConfigPanel feat={feat} cfg={cfg} />}
            </div>
          );
        }

        return (
          <div className="space-y-5">
            {/* Section heading */}
            <div className="flex items-center gap-2.5">
              <SparkAnvil size={20} className="text-primary shrink-0" />
              <div>
                <p className="text-sm font-semibold leading-tight">Production features</p>
                <p className="text-[11px] text-muted-foreground">Select and configure finishing options for your video</p>
              </div>
            </div>


            {/* Duration — auto-calculated from selected clips/VOD */}
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">Estimated output duration</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {clipSpec
                    ? `Calculated from your ${clipSpec.clips.length} confirmed clip${clipSpec.clips.length !== 1 ? 's' : ''}`
                    : effectiveSource === 'source'
                      ? 'Estimated from your selected source — AuraFlux will decide the cut points'
                      : 'Based on your source material'}
                </p>
              </div>
              <span className="text-lg font-bold tabular-nums text-primary shrink-0 ml-4">{durationMins} min</span>
            </div>

            {/* 4 category boxes — CPD-420 Phase 2 feature set UI */}
            {CATEGORY_BOXES
              .filter((box) => formFactor && box.formFactors.includes(formFactor))
              .map((box) => {
                const boxFeats = FEATURES.filter(
                  (f) =>
                    f.category === box.id &&
                    f.status === 'live' &&
                    formFactor &&
                    f.formFactors.includes(formFactor)
                );
                if (boxFeats.length === 0) return null;
                const activeCount = boxFeats.filter((f) => features.has(f.id)).length;
                const isExpanded = expandedBoxes.has(box.id);
                return (
                  <div key={box.id} className="rounded-lg border border-border overflow-hidden">
                    {/* Box header — click to expand/collapse */}
                    <button
                      type="button"
                      onClick={() => setExpandedBoxes((prev) => {
                        const next = new Set(prev);
                        if (next.has(box.id)) next.delete(box.id);
                        else next.add(box.id);
                        return next;
                      })}
                      className="w-full flex items-center justify-between px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-base leading-none">{box.icon}</span>
                        <div>
                          <p className="text-xs font-semibold text-foreground leading-tight">{box.label}</p>
                          <p className="text-[10px] text-muted-foreground">{box.description}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {activeCount > 0 && (
                          <span className="text-[10px] font-medium text-primary bg-primary/10 rounded-full px-2 py-0.5">
                            {activeCount} on
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">{isExpanded ? '↑' : '↓'}</span>
                      </div>
                    </button>
                    {/* Box items */}
                    {isExpanded && (
                      <div className="px-3 py-2 space-y-1.5 border-t border-border">
                        {boxFeats.map((feat) => (
                          <div key={feat.id} title={feat.tooltip}>
                            <FeatureRow feat={feat} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

            {/* Selection summary — live cart-style summary of active features */}
            {features.size > 0 && (
              <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Your selections</p>
                <div className="space-y-1">
                  {CATEGORY_BOXES.filter((box) => formFactor && box.formFactors.includes(formFactor)).map((box) => {
                    const sel = FEATURES.filter((f) => f.category === box.id && features.has(f.id));
                    if (!sel.length) return null;
                    return (
                      <div key={box.id} className="flex items-start gap-2 text-[11px]">
                        <span className="text-sm leading-none mt-0.5 shrink-0">{box.icon}</span>
                        <div className="flex items-start gap-1.5 flex-wrap">
                          <span className="text-muted-foreground shrink-0 font-medium">{box.label}:</span>
                          {sel.map((f) => (
                            <span key={f.id} className="bg-primary/10 text-primary rounded-full px-1.5 py-0.5 text-[10px] font-medium">{f.label}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Live credit estimate */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                  Credit estimate
                </span>
                <span className="text-sm font-bold text-primary tabular-nums">{estimate.credits} credits</span>
              </div>
              <p className="text-xs text-foreground/80 leading-relaxed">{estimate.message}</p>
              <p className="text-[10px] text-muted-foreground">
                Credits are charged at submission. Adjust duration or features above to see the impact.
              </p>
            </div>
          </div>
        );
      })()}

      {/* Step 3 — Checkout: order review + delivery settings */}
      {step === 3 && (
        <div className="space-y-5">

          {/* Order review header */}
          <div>
            <h2 className="text-base font-semibold">Review your order</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Confirm everything looks right before starting production</p>
          </div>

          {/* Order line items */}
          <div className="space-y-2">

            {/* Format */}
            <div className="flex items-center justify-between rounded-lg border px-3 py-3">
              <div className="flex items-center gap-3">
                <span className="text-lg leading-none">📐</span>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide leading-none mb-0.5">Format</p>
                  <p className="text-sm font-medium">{formFactor === 'long' ? 'Long-form (16:9)' : 'Short-form (9:16)'}</p>
                  <p className="text-[11px] text-muted-foreground">{formFactor === 'long' ? 'YouTube, compilations, full episodes' : 'TikTok, Reels, YouTube Shorts'}</p>
                </div>
              </div>
              <button type="button" onClick={() => setStep(0 as Step)} className="text-[10px] text-primary hover:underline shrink-0 ml-3">Edit</button>
            </div>

            {/* Source */}
            <div className="flex items-center justify-between rounded-lg border px-3 py-3">
              <div className="flex items-center gap-3">
                <span className="text-lg leading-none">🎬</span>
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide leading-none mb-0.5">Source</p>
                  <p className="text-sm font-medium">
                    {sourceIntent === 'longform' ? 'Long-form video / VOD' : 'Short clips'}
                    <span className="font-normal text-muted-foreground"> · {effectiveSource === 'source' ? 'channel browse' : effectiveSource === 'fetch' ? 'URL fetch' : 'file upload'}</span>
                  </p>
                  {sourceIntent === 'longform' && formFactor === 'short' && (
                    <p className="text-[11px] text-primary">→ We&apos;ll cut short clips from your long video</p>
                  )}
                  {sourceIntent === 'clips' && formFactor === 'long' && (
                    <p className="text-[11px] text-primary">→ We&apos;ll compile your clips into a long-form video</p>
                  )}
                </div>
              </div>
              <button type="button" onClick={() => setStep(1 as Step)} className="text-[10px] text-primary hover:underline shrink-0 ml-3">Edit</button>
            </div>

            {/* Features */}
            <div className="flex items-start justify-between rounded-lg border px-3 py-3">
              <div className="flex items-start gap-3 min-w-0">
                <span className="text-lg leading-none mt-0.5 shrink-0">⚙️</span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide leading-none mb-1">Production features</p>
                  {features.size === 0 ? (
                    <p className="text-sm text-muted-foreground">None selected — default pipeline</p>
                  ) : (
                    <div className="space-y-1">
                      {CATEGORY_BOXES.map((box) => {
                        const sel = FEATURES.filter((f) => f.category === box.id && features.has(f.id));
                        if (!sel.length) return null;
                        return (
                          <div key={box.id} className="flex items-start gap-1.5 text-[11px]">
                            <span className="shrink-0">{box.icon}</span>
                            <span className="text-muted-foreground shrink-0 font-medium">{box.label}:</span>
                            <span className="text-foreground/80">{sel.map((f) => f.label).join(', ')}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <button type="button" onClick={() => setStep(2 as Step)} className="text-[10px] text-primary hover:underline shrink-0 ml-3">Edit</button>
            </div>

          </div>

          {/* Delivery settings */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delivery</p>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <LockedFeature
                  key={p.id}
                  minPlan={p.minPlan ?? 'operate'}
                  currentPlan={planTier ?? 'operate'}
                  label={p.label}
                  upgradeMsg={`TikTok direct publishing is included in the Managed plan`}
                >
                  <button
                    type="button"
                    onClick={() => p.minPlan ? undefined : togglePlatform(p.id)}
                    className={cn(
                      'px-3 py-2 text-sm rounded-md border transition-colors font-medium',
                      platforms.includes(p.id)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-foreground/70 hover:text-foreground hover:border-foreground/30',
                    )}
                  >
                    {p.label}
                  </button>
                </LockedFeature>
              ))}
            </div>

            <JobTimingPicker platforms={platforms} value={jobTiming} onChange={setJobTiming} />
          </div>

          {/* Credit total */}
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3.5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-primary">Total cost</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{estimate.message}</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold text-primary tabular-nums">{estimate.credits}</p>
                <p className="text-[10px] text-muted-foreground">credits</p>
              </div>
            </div>
          </div>

          {/* Add-on extensions (HeyGen, Shoppable) — hidden from UI, wired in code.
               Managed-plan add-ons will be surfaced once onboarding flow is complete. */}
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
      )}

      <Separator />

      {/* P0-1: hide wizard nav at step 1.5 — ClipEditor has its own Confirm/Cancel */}
      {(step as number) !== 1.5 && (
        <div className="flex gap-2 justify-between">
          <button
            type="button"
            onClick={() => {
              if (step === 0) { router.back(); return; }
              // step 1.5 Back must go to step 1
              if ((step as number) === 1.5) { setStep(1 as Step); return; }
              setStep((s) => ((s as number) - 1) as Step);
            }}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          <Button size="sm" disabled={isPending || (step === 1 && !sourceIntent)} onClick={advance}>
            {isPending
              ? 'Starting production…'
              : step === 3
                ? (jobTiming.productionStart.mode === 'scheduled' ? 'Schedule production' : 'Confirm & start production →')
                : 'Next →'}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function NewJobPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Loading…</div>}>
      <NewJobPageInner />
    </Suspense>
  );
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
