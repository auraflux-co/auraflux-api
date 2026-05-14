'use client';
/**
 * /dashboard/jobs/new — Job submission wizard (CPD-110, CPD-113)
 *
 * Platform-agnostic 5-step flow:
 *   1. Format        — Long-form (16:9) or Short-form (9:16)
 *   2. Path          — production path based on what customer brings
 *   3. Source        — upload file keys or fetch URLs
 *   4. Features      — production capabilities to apply
 *   5. Publish       — platform, schedule, add-on extensions
 *
 * CPD-113: AuraFlux Guide is integral to accuracy —
 *   • Guide auto-opens on mount with step-0 context
 *   • Context hint updates on every step change
 *   • Inline GuideTip card visible beneath each step's choices
 */

import { useState, useTransition, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createJob, estimateCreditCost, getTemplateById, type CreateJobPayload } from '@/lib/api';
import { VideoUpload } from '@/components/upload/video-upload';
import { SchedulePicker, type ScheduleValue } from '@/components/jobs/schedule-picker';
import { LockedFeature } from '@/components/ui/locked-feature';
import { useGuide } from '@/contexts/guide-context';
import { usePlan } from '@/contexts/plan-context';

// ─── Types ────────────────────────────────────────────────────────────────────

type FormFactor = 'long' | 'short';

type ProductionPath =
  | 'long_compile_clips'
  | 'long_produce_source'
  | 'short_cut_longform'
  | 'short_enhance_upload'
  | 'short_fetch_enhance';

type SourceMode = 'upload' | 'fetch';

interface Feature {
  id:          string;
  label:       string;
  description: string;
  default:     boolean;
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
  // Long-form only — scripting & narration pipeline
  { id: 'script',       label: 'Script generation',   description: 'Writes the video script from your source',                             default: true,  formFactors: ['long']          },
  { id: 'tts',          label: 'TTS narration',        description: 'ElevenLabs voiceover on the generated script',                         default: false, formFactors: ['long']          },
  { id: 'commentary',   label: 'Text narration',       description: 'Narrative commentary layered over the video',                          default: false, formFactors: ['long']          },
  { id: 'generation',   label: 'Video generation',     description: 'WAN text-to-video for segments without source footage',                default: false, formFactors: ['long']          },
  // Both form factors
  { id: 'scene_select', label: 'Scene selection',      description: 'Selects the best clips and scenes from your source',                   default: true,  formFactors: ['long', 'short'] },
  { id: 'branding',     label: 'Logo & branding',      description: 'Apply your brand config — colours, logo, lower thirds',                default: true,  formFactors: ['long', 'short'] },
  { id: 'burn_images',  label: 'Burn images',          description: 'Embed still images as overlays in the video',                          default: false, formFactors: ['long', 'short'] },
  { id: 'dynamic',      label: 'Dynamic overlays',     description: 'Animated text, scoreboards, and motion graphics',                      default: false, formFactors: ['long', 'short'] },
];

const ADD_ONS = [
  { id: 'heygen',    label: 'HeyGen Avatar IV',  description: 'Avatar presenter rendered for each video',  badge: 'Managed', minPlan: 'managed' as const },
  { id: 'shoppable', label: 'Shoppable tagging', description: 'Product tags embedded for social commerce', badge: 'Managed', minPlan: 'managed' as const },
];

const PLATFORMS = [
  { id: 'youtube',   label: 'YouTube',   minPlan: undefined },
  { id: 'tiktok',    label: 'TikTok',    minPlan: 'managed' as const },
  { id: 'instagram', label: 'Instagram', minPlan: undefined },
];

// ─── Guide content ────────────────────────────────────────────────────────────
// Inline tip shown beneath step choices + context hint sent to the guide panel.

interface GuideContent {
  tip:     string;
  hint:    string; // sent to the guide panel context banner
}

const STEP_GUIDE: Record<number, GuideContent> = {
  0: {
    tip:  'Format determines the entire pipeline. Long-form (16:9) is best for news, sports commentary, show clips, and compilations. Short-form (9:16) is built for TikTok, Reels, and YouTube Shorts. You can run both as separate jobs from the same source.',
    hint: 'Step 1 of 5 — Format. Ask me which format works best for your content type, or what the difference means for your pipeline.',
  },
  1: {
    tip:  '"Produce from source" runs the full production pipeline — scripting, narration, and assembly. "Compile from clips" is best when you already have raw footage and want us to cut and sequence it. When in doubt, start with "Produce from source."',
    hint: 'Step 2 of 5 — Production path. I can explain which path is right for your content type and what happens to your video at each portal.',
  },
  2: {
    tip:  'For URL fetch: paste YouTube, Twitch, Rumble, or direct video URLs — we pull the video for you. For upload: drag your file or click to browse. MP4, MOV, AVI, WebM up to 2 GB.',
    hint: 'Step 3 of 5 — Source. Ask me about supported URL formats, how uploads work, or what happens to your source file in the pipeline.',
  },
  3: {
    tip:  'Script + TTS together give you a fully narrated video — no voiceover needed. Scene selection is key for sports and long-form compilations. Video generation fills in segments where you have no source footage. Start conservative — you can always re-run with more features.',
    hint: 'Step 4 of 5 — Features. I can explain what each feature does to your video, which ones work best together, and how they affect credits and production time.',
  },
  4: {
    tip:  'Schedule at least 30 minutes out to allow production time. HeyGen and Shoppable are Managed plan add-ons — they add significant production value. Platforms you select here determine which portals run in the publish stage.',
    hint: 'Step 5 of 5 — Platform, publish & add-ons. Ask me about platform requirements, scheduling, credit costs, or whether add-ons make sense for your plan.',
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
        <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">AuraFlux Collab</span>
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

const STEPS = ['Format', 'Path', 'Source', 'Features', 'Publish'] as const;
type Step = 0 | 1 | 2 | 3 | 4;

function StepHeader({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center">
          <div className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors',
            i === step  ? 'bg-primary text-primary-foreground font-medium'
              : i < step  ? 'text-muted-foreground'
              : 'text-muted-foreground/40',
          )}>
            <span className={cn(
              'w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-semibold border',
              i === step  ? 'border-primary-foreground/30 bg-primary-foreground/10'
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
  const [step, setStep] = useState<Step>(0);
  const [error, setError] = useState<string | null>(null);
  const [templateBanner, setTemplateBanner] = useState<string | null>(null);

  const { openWithContext, setContextHint } = useGuide();
  const { planTier } = usePlan();

  // Wizard state
  const [formFactor, setFormFactor] = useState<FormFactor | null>(null);
  const [path, setPath]             = useState<ProductionPath | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode | null>(null);
  const [sourceUrls, setSourceUrls] = useState('');
  const [fileKeys,    setFileKeys]    = useState('');
  const [uploadedKey, setUploadedKey] = useState<string | null>(null);
  const [uploadedName,setUploadedName]= useState<string | null>(null);
  const [topic, setTopic]           = useState('');
  const [tone, setTone]             = useState('professional');
  const [features, setFeatures]     = useState<Set<string>>(
    () => new Set(FEATURES.filter((f) => f.default).map((f) => f.id))
  );
  const [featureConfig, setFeatureConfig] = useState<Record<string, Record<string, string>>>({});
  function setFeatureCfg(featureId: string, key: string, value: string) {
    setFeatureConfig((prev) => ({
      ...prev,
      [featureId]: { ...(prev[featureId] ?? {}), [key]: value },
    }));
  }
  const [platforms, setPlatforms]   = useState<string[]>(['youtube']);
  const [addOns, setAddOns]         = useState<Set<string>>(new Set());
  const [schedule, setSchedule]     = useState<ScheduleValue>({ publishMode: 'immediate' });
  // CPD-115: duration + live credit estimate
  const [durationMins, setDurationMins] = useState<number>(formFactor === 'short' ? 1 : 3);

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
        const pp = (spec.productionPath as ProductionPath) || null;
        if (pp) setPath(pp);
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
    if (step === 1 && !path) { setError('Select a production path to continue'); return; }
    if (step === 2) {
      const pathConfig = PRODUCTION_PATHS[formFactor!].find((p) => p.id === path);
      const mode = sourceMode ?? pathConfig?.sources[0];
      if (mode === 'fetch') {
        if (!sourceUrls.split('\n').map((u) => u.trim()).filter(Boolean).length) {
          setError('Enter at least one URL'); return;
        }
      } else {
        if (!fileKeys.trim()) {
          setError('Please upload a video file before continuing'); return;
        }
      }
    }
    if (step === 4) { handleSubmit(); return; }
    setStep((s) => (s + 1) as Step);
  }

  async function handleSubmit() {
    setError(null);
    const pathConfig = PRODUCTION_PATHS[formFactor!].find((p) => p.id === path!);
    const mode = sourceMode ?? pathConfig!.sources[0];

    // Merge tone into featureConfig.script so it travels with the feature
    const mergedConfig = { ...featureConfig };
    if (tone && features.has('script')) {
      mergedConfig.script = { ...(mergedConfig.script ?? {}), tone };
    }

    const payload: CreateJobPayload = {
      contentType:    pathToContentType(path!),
      entryType:      mode,
      platforms,
      formFactor,
      productionPath: path,
      features:       Array.from(features),
      extensions:     Array.from(addOns),
      durationMins,
      publishMode:    schedule.publishMode,
      topic:          topic.trim() || undefined,
      tone:           tone || undefined,
      featureConfig:  Object.keys(mergedConfig).length ? mergedConfig : undefined,
    };

    if (mode === 'fetch') {
      payload.fetchSpec = { sourceUrls: sourceUrls.split('\n').map((u) => u.trim()).filter(Boolean) };
    } else {
      payload.uploadSpec = { fileKeys: fileKeys.split('\n').map((k) => k.trim()).filter(Boolean) };
    }

    if (schedule.publishMode === 'scheduled' && schedule.scheduledPublishAt) {
      payload.scheduledPublishAt = schedule.scheduledPublishAt;
    }

    start(async () => {
      try {
        const token = await getToken();
        const res = await createJob(payload, token ?? undefined);
        console.info('[new-job] created', res.jobId);
        router.push('/dashboard/jobs/active');
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to create job');
      }
    });
  }

  const pathOptions        = formFactor ? PRODUCTION_PATHS[formFactor] : [];
  const selectedPathConfig = path ? pathOptions.find((p) => p.id === path) : null;
  const availableSources   = selectedPathConfig?.sources ?? [];
  const effectiveSource    = sourceMode ?? availableSources[0];

  return (
    <div className="max-w-2xl space-y-5">
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
                  setPath(null);
                  setSourceMode(null);
                  // Seed defaults for this form factor
                  setFeatures(new Set(FEATURES.filter((f) => f.default && f.formFactors.includes(opt.id)).map((f) => f.id)));
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
          <GuideTip step={0} />
        </div>
      )}

      {/* Step 1 — Production path */}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">What are you working with and what do you want to produce?</p>
          <div className="space-y-2">
            {pathOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => { setPath(opt.id); setSourceMode(null); }}
                className={cn(
                  'w-full text-left p-4 rounded-lg border transition-colors',
                  path === opt.id ? 'border-primary bg-primary/5' : 'border-border hover:border-border/80',
                )}
              >
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
              </button>
            ))}
          </div>
          <GuideTip step={1} />
        </div>
      )}

      {/* Step 2 — Source */}
      {step === 2 && selectedPathConfig && (
        <div className="space-y-4">
          {/* Content context — topic and tone */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Video topic <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. breakthrough in healthcare"
                className="text-sm"
              />
              <p className="text-[10px] text-muted-foreground">What is this video about? Used for script generation.</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Tone</Label>
              <select
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {['professional','informative','casual','energetic','hype','punchy','urgent','conversational'].map((t) => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
              <p className="text-[10px] text-muted-foreground">Controls the script voice and language style.</p>
            </div>
          </div>

          {availableSources.length > 1 && (
            <div className="flex gap-2">
              {availableSources.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSourceMode(s)}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-md border transition-colors',
                    effectiveSource === s
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {s === 'upload' ? 'Upload files' : 'Fetch from URLs'}
                </button>
              ))}
            </div>
          )}
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
          <GuideTip step={2} />
        </div>
      )}

      {/* Step 3 — Features */}
      {step === 3 && (() => {
        const estimate = estimateCreditCost({
          durationMins,
          features: Array.from(features),
          extensions: Array.from(addOns),
          sourceMode: effectiveSource ?? '',
          planTier: planTier ?? 'operate',
        });
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Select production capabilities and configure each one.</p>

            {/* Duration slider */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">Target video duration</Label>
                <span className="text-sm font-semibold tabular-nums">{durationMins} min</span>
              </div>
              <input
                type="range"
                min={1}
                max={formFactor === 'short' ? 3 : 15}
                step={1}
                value={durationMins}
                onChange={(e) => setDurationMins(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>1 min</span>
                <span>{formFactor === 'short' ? '3 min' : '15 min'}</span>
              </div>
            </div>

            <div className="space-y-2">
              {FEATURES.filter((f) => formFactor && f.formFactors.includes(formFactor)).map((feat) => {
                const on = features.has(feat.id);
                const cfg = featureConfig[feat.id] ?? {};
                return (
                  <div
                    key={feat.id}
                    className={cn(
                      'rounded-lg border transition-colors',
                      on ? 'border-primary' : 'border-border',
                    )}
                  >
                    {/* Toggle row */}
                    <button
                      type="button"
                      onClick={() => toggleFeature(feat.id)}
                      className={cn(
                        'w-full flex items-center gap-3 p-3 text-left transition-colors rounded-lg',
                        on ? 'bg-primary/5' : 'hover:bg-muted/40',
                      )}
                    >
                      <span className={cn(
                        'w-4 h-4 rounded border shrink-0 flex items-center justify-center text-[10px] font-bold',
                        on ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30',
                      )}>
                        {on ? '✓' : ''}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-tight">{feat.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{feat.description}</p>
                      </div>
                      {on && feat.id !== 'scene_select' && feat.id !== 'branding' && feat.id !== 'dynamic' && (
                        <span className="text-[10px] text-primary font-medium shrink-0">configure ↓</span>
                      )}
                    </button>

                    {/* Inline config panel — shown when feature is ON */}
                    {on && feat.id === 'script' && (
                      <div className="px-3 pb-3 pt-1 border-t border-primary/10 bg-primary/5 space-y-3">
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
                            Content brief <span className="normal-case font-normal">(optional — key points, angles, context)</span>
                          </Label>
                          <textarea
                            value={cfg.brief ?? ''}
                            onChange={(e) => setFeatureCfg('script', 'brief', e.target.value)}
                            placeholder="e.g. Focus on the comeback story in the 4th quarter. Include player stats for Johnson and Moore."
                            rows={3}
                            className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                          />
                        </div>
                      </div>
                    )}

                    {on && feat.id === 'tts' && (
                      <div className="px-3 pb-3 pt-1 border-t border-primary/10 bg-primary/5 space-y-3">
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
                          <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                            Speaking speed
                          </Label>
                          <div className="flex items-center gap-3">
                            <input
                              type="range"
                              min={0.7}
                              max={1.3}
                              step={0.1}
                              value={cfg.speed ?? '1.0'}
                              onChange={(e) => setFeatureCfg('tts', 'speed', e.target.value)}
                              className="flex-1 accent-primary"
                            />
                            <span className="text-xs font-medium tabular-nums w-8">{cfg.speed ?? '1.0'}×</span>
                          </div>
                          <div className="flex justify-between text-[10px] text-muted-foreground">
                            <span>Slower</span>
                            <span>Faster</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {on && feat.id === 'commentary' && (
                      <div className="px-3 pb-3 pt-1 border-t border-primary/10 bg-primary/5 space-y-3">
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
                            Narration notes <span className="normal-case font-normal">(optional)</span>
                          </Label>
                          <textarea
                            value={cfg.notes ?? ''}
                            onChange={(e) => setFeatureCfg('commentary', 'notes', e.target.value)}
                            placeholder="e.g. Focus on emotional moments, mention the crowd reaction, keep under 20 words per segment."
                            rows={2}
                            className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                          />
                        </div>
                      </div>
                    )}

                    {on && feat.id === 'generation' && (
                      <div className="px-3 pb-3 pt-1 border-t border-primary/10 bg-primary/5 space-y-3">
                        <div className="space-y-1.5">
                          <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                            Visual prompt <span className="normal-case font-normal">(optional — auto-generated from topic if blank)</span>
                          </Label>
                          <textarea
                            value={cfg.prompt ?? ''}
                            onChange={(e) => setFeatureCfg('generation', 'prompt', e.target.value)}
                            placeholder="e.g. Wide establishing shot of a packed stadium at sunset, crowd cheering, cinematic lens flare"
                            rows={3}
                            className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Visual style</Label>
                          <select
                            value={cfg.visualStyle ?? 'cinematic'}
                            onChange={(e) => setFeatureCfg('generation', 'visualStyle', e.target.value)}
                            className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                          >
                            <option value="cinematic">Cinematic — film-grade, dramatic lighting</option>
                            <option value="documentary">Documentary — natural, handheld feel</option>
                            <option value="clean">Clean — bright, modern, commercial</option>
                            <option value="dynamic">Dynamic — fast cuts, high energy, sports</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {on && feat.id === 'burn_images' && (
                      <div className="px-3 pb-3 pt-1 border-t border-primary/10 bg-primary/5 space-y-3">
                        <div className="space-y-1.5">
                          <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                            Image URLs <span className="normal-case font-normal">(one per line — direct links to .jpg, .png, .webp)</span>
                          </Label>
                          <textarea
                            value={cfg.imageUrls ?? ''}
                            onChange={(e) => setFeatureCfg('burn_images', 'imageUrls', e.target.value)}
                            placeholder="https://cdn.example.com/image1.jpg&#10;https://cdn.example.com/image2.png"
                            rows={3}
                            className="w-full text-sm font-mono border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Overlay position</Label>
                          <select
                            value={cfg.position ?? 'lower-third'}
                            onChange={(e) => setFeatureCfg('burn_images', 'position', e.target.value)}
                            className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                          >
                            <option value="lower-third">Lower third</option>
                            <option value="full-frame">Full frame (transitions)</option>
                            <option value="corner">Corner watermark</option>
                            <option value="center">Center (title card)</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Live credit estimate */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                  AuraFlux Collab — Credit Estimate
                </span>
                <span className="text-sm font-bold text-primary tabular-nums">
                  {estimate.credits} credits
                </span>
              </div>
              <p className="text-xs text-foreground/80 leading-relaxed">{estimate.message}</p>
              <p className="text-[10px] text-muted-foreground">
                Credits are charged at submission. Adjust duration or features above to see the impact.
              </p>
            </div>
          </div>
        );
      })()}

      {/* Step 4 — Platform, Publish, Add-ons */}
      {step === 4 && (
        <div className="space-y-5">
          <div className="space-y-2">
            <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Platforms</Label>
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
                      'px-3 py-1.5 text-xs rounded-md border transition-colors',
                      platforms.includes(p.id)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {p.label}
                  </button>
                </LockedFeature>
              ))}
            </div>
          </div>

          <SchedulePicker platforms={platforms} value={schedule} onChange={setSchedule} />

          <div className="space-y-2">
            <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Add-on extensions</Label>
            <div className="space-y-2">
              {ADD_ONS.map((ao) => {
                const on = addOns.has(ao.id);
                return (
                  <LockedFeature
                    key={ao.id}
                    minPlan={ao.minPlan ?? 'operate'}
                    currentPlan={planTier ?? 'operate'}
                    label={ao.label}
                    upgradeMsg={`${ao.label} is included in the Managed plan`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleAddOn(ao.id)}
                      className={cn(
                        'w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors',
                        on ? 'border-primary bg-primary/5' : 'border-border hover:border-border/80',
                      )}
                    >
                      <span className={cn(
                        'w-4 h-4 rounded border shrink-0 flex items-center justify-center text-[10px] font-bold',
                        on ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30',
                      )}>{on ? '✓' : ''}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium leading-tight">{ao.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{ao.description}</p>
                      </div>
                      <Badge variant="secondary" className="text-[10px] shrink-0">{ao.badge}</Badge>
                    </button>
                  </LockedFeature>
                );
              })}
            </div>
          </div>

          {/* Review summary */}
          <Card className="bg-muted/30 border-dashed">
            <CardContent className="pt-4 space-y-2 text-xs text-muted-foreground">
              <p><span className="font-medium text-foreground">Format:</span> {formFactor === 'long' ? 'Long-form (16:9)' : 'Short-form (9:16)'}</p>
              <p><span className="font-medium text-foreground">Path:</span> {selectedPathConfig?.label}</p>
              <p><span className="font-medium text-foreground">Source:</span> {effectiveSource === 'fetch' ? 'Fetch from URLs' : 'Upload files'}</p>
              {topic.trim() && <p><span className="font-medium text-foreground">Topic:</span> {topic.trim()}</p>}
              <p><span className="font-medium text-foreground">Tone:</span> {tone}</p>
              <p><span className="font-medium text-foreground">Features:</span> {Array.from(features).map((id) => FEATURES.find((f) => f.id === id)?.label).filter(Boolean).join(', ') || 'None'}</p>
              <p><span className="font-medium text-foreground">Platforms:</span> {platforms.join(', ')}</p>
              {addOns.size > 0 && <p><span className="font-medium text-foreground">Add-ons:</span> {Array.from(addOns).join(', ')}</p>}
            </CardContent>
          </Card>

          <GuideTip step={4} />
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      <Separator />

      <div className="flex gap-2 justify-between">
        <button
          type="button"
          onClick={() => step === 0 ? router.back() : setStep((s) => (s - 1) as Step)}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        >
          {step === 0 ? 'Cancel' : '← Back'}
        </button>
        <Button size="sm" disabled={isPending} onClick={advance}>
          {isPending ? 'Submitting…' : step === 4 ? 'Submit job' : 'Next →'}
        </Button>
      </div>
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
