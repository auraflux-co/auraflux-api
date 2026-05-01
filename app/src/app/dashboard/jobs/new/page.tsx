'use client';
/**
 * /dashboard/jobs/new — Job submission wizard (CPD-110)
 *
 * Platform-agnostic 5-step flow:
 *   1. Form factor   — Long-form (16:9) or Short-form (9:16)
 *   2. Production path — what the customer brings + what we produce
 *   3. Source          — upload file keys or fetch URLs
 *   4. Features        — production capabilities to apply
 *   5. Platform + Publish + Add-ons
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createJob, type CreateJobPayload } from '@/lib/api';
import { SchedulePicker, type ScheduleValue } from '@/components/jobs/schedule-picker';

// ─── Types ────────────────────────────────────────────────────────────────────

type FormFactor = 'long' | 'short';

type ProductionPath =
  | 'long_compile_clips'      // compile short clips → long-form
  | 'long_produce_source'     // fetch/upload long-form source → produce finished video
  | 'short_cut_longform'      // extract short clips from long-form
  | 'short_enhance_upload'    // upload short clips + add design
  | 'short_fetch_enhance';    // fetch short content + add design

type SourceMode = 'upload' | 'fetch';

interface Feature {
  id:          string;
  label:       string;
  description: string;
  default:     boolean;
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
  { id: 'script',       label: 'Script generation',        description: 'AI writes the video script from your source',          default: true  },
  { id: 'tts',          label: 'TTS narration',            description: 'ElevenLabs voiceover on the generated script',         default: false },
  { id: 'commentary',   label: 'Text narration',           description: 'Narrative commentary layered over the video',          default: false },
  { id: 'scene_select', label: 'Scene selection',          description: 'AI selects the best clips and scenes from your source', default: false },
  { id: 'generation',   label: 'AI video generation',      description: 'WAN text-to-video for segments without source footage', default: false },
  { id: 'branding',     label: 'Logo & branding',          description: 'Apply your brand config — colours, logo, lower thirds', default: true  },
  { id: 'burn_images',  label: 'Burn images',              description: 'Embed still images as overlays in the video',           default: false },
  { id: 'dynamic',      label: 'Dynamic overlays',         description: 'Animated text, scoreboards, and motion graphics',      default: false },
];

const ADD_ONS = [
  { id: 'heygen',    label: 'HeyGen avatar',     description: 'AI presenter rendered for each video',       badge: 'DFY' },
  { id: 'shoppable', label: 'Shoppable tagging', description: 'Product tags embedded for social commerce',  badge: 'DFY' },
];

const PLATFORMS = [
  { id: 'youtube',   label: 'YouTube'   },
  { id: 'tiktok',    label: 'TikTok'    },
  { id: 'instagram', label: 'Instagram' },
];

// ─── Path → backend fields ────────────────────────────────────────────────────

function pathToContentType(path: ProductionPath): string {
  switch (path) {
    case 'long_compile_clips':   return 'clips-long';
    case 'long_produce_source':  return 'custom';
    case 'short_cut_longform':   return 'clips-short';
    case 'short_enhance_upload': return 'custom';
    case 'short_fetch_enhance':  return 'custom';
  }
}

function pathToEntryType(path: ProductionPath, source: SourceMode): 'fetch' | 'upload' {
  if (source === 'fetch') return 'fetch';
  return 'upload';
}

// ─── Wizard steps ─────────────────────────────────────────────────────────────

const STEPS = ['Format', 'Path', 'Source', 'Features', 'Publish'] as const;
type Step = 0 | 1 | 2 | 3 | 4;

function StepHeader({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center">
          <div className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors',
            i === step ? 'bg-primary text-primary-foreground font-medium'
              : i < step  ? 'text-muted-foreground'
              : 'text-muted-foreground/40',
          )}>
            <span className={cn(
              'w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-semibold border',
              i === step ? 'border-primary-foreground/30 bg-primary-foreground/10'
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

export default function NewJobPage() {
  const router = useRouter();
  const { getToken } = useAuth();
  const [isPending, start] = useTransition();
  const [step, setStep] = useState<Step>(0);
  const [error, setError] = useState<string | null>(null);

  // Wizard state
  const [formFactor, setFormFactor]       = useState<FormFactor | null>(null);
  const [path, setPath]                   = useState<ProductionPath | null>(null);
  const [sourceMode, setSourceMode]       = useState<SourceMode | null>(null);
  const [sourceUrls, setSourceUrls]       = useState('');
  const [fileKeys, setFileKeys]           = useState('');
  const [features, setFeatures]           = useState<Set<string>>(
    () => new Set(FEATURES.filter((f) => f.default).map((f) => f.id))
  );
  const [platforms, setPlatforms]         = useState<string[]>(['youtube']);
  const [addOns, setAddOns]               = useState<Set<string>>(new Set());
  const [schedule, setSchedule]           = useState<ScheduleValue>({ publishMode: 'immediate' });

  function toggleFeature(id: string) {
    setFeatures((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function togglePlatform(id: string) {
    setPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  function toggleAddOn(id: string) {
    setAddOns((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function advance() {
    setError(null);
    if (step === 0 && !formFactor) { setError('Select a format'); return; }
    if (step === 1 && !path) { setError('Select a production path'); return; }
    if (step === 2) {
      const pathConfig = PRODUCTION_PATHS[formFactor!].find((p) => p.id === path);
      if (!sourceMode && pathConfig && pathConfig.sources.length > 1) {
        // auto-select if only one option
      }
      const mode = sourceMode ?? pathConfig?.sources[0];
      if (mode === 'fetch') {
        const urls = sourceUrls.split('\n').map((u) => u.trim()).filter(Boolean);
        if (urls.length === 0) { setError('Enter at least one URL'); return; }
      } else {
        const keys = fileKeys.split('\n').map((k) => k.trim()).filter(Boolean);
        if (keys.length === 0) { setError('Enter at least one storage key'); return; }
      }
    }
    if (step === 4) { handleSubmit(); return; }
    setStep((s) => (s + 1) as Step);
  }

  async function handleSubmit() {
    setError(null);
    const pathConfig = PRODUCTION_PATHS[formFactor!].find((p) => p.id === path!);
    const mode = sourceMode ?? pathConfig!.sources[0];

    const payload: CreateJobPayload = {
      contentType:    pathToContentType(path!),
      entryType:      pathToEntryType(path!, mode),
      platforms,
      formFactor,
      productionPath: path,
      features:       Array.from(features),
      extensions:     Array.from(addOns),
      publishMode:    schedule.publishMode,
    };

    if (mode === 'fetch') {
      const urls = sourceUrls.split('\n').map((u) => u.trim()).filter(Boolean);
      payload.fetchSpec = { sourceUrls: urls };
    } else {
      const keys = fileKeys.split('\n').map((k) => k.trim()).filter(Boolean);
      payload.uploadSpec = { fileKeys: keys };
    }

    if (schedule.publishMode === 'scheduled' && schedule.scheduledPublishAt) {
      payload.scheduledPublishAt = schedule.scheduledPublishAt;
    }

    start(async () => {
      try {
        const token = await getToken();
        const res = await createJob(payload, token ?? undefined);
        console.info('[new-job] created', res.jobId);
        router.push('/dashboard/jobs');
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to create job');
      }
    });
  }

  const pathOptions = formFactor ? PRODUCTION_PATHS[formFactor] : [];
  const selectedPathConfig = path ? pathOptions.find((p) => p.id === path) : null;
  const availableSources = selectedPathConfig?.sources ?? [];
  const effectiveSource = sourceMode ?? availableSources[0];

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">New job</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Configure your content production job</p>
      </div>

      <StepHeader step={step} />

      <Separator />

      {/* Step 0 — Form factor */}
      {step === 0 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">What format do you want to produce?</p>
          <div className="grid grid-cols-2 gap-3">
            {([
              { id: 'long',  label: 'Long-form',  sub: '16:9 landscape — YouTube, full episodes, compilations' },
              { id: 'short', label: 'Short-form',  sub: '9:16 portrait — TikTok, Reels, YouTube Shorts' },
            ] as { id: FormFactor; label: string; sub: string }[]).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => { setFormFactor(opt.id); setPath(null); setSourceMode(null); }}
                className={cn(
                  'text-left p-4 rounded-lg border transition-colors space-y-1',
                  formFactor === opt.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-border/80',
                )}
              >
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground">{opt.sub}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 1 — Production path */}
      {step === 1 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">What are you working with and what do you want to produce?</p>
          <div className="space-y-2">
            {pathOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => { setPath(opt.id); setSourceMode(null); }}
                className={cn(
                  'w-full text-left p-4 rounded-lg border transition-colors',
                  path === opt.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-border/80',
                )}
              >
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2 — Source */}
      {step === 2 && selectedPathConfig && (
        <div className="space-y-4">
          {/* Source mode toggle — only show if path supports both */}
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
              <Label className="text-xs">Storage keys <span className="text-muted-foreground">(one per line — from Upload API or R2)</span></Label>
              <Textarea
                value={fileKeys}
                onChange={(e) => setFileKeys(e.target.value)}
                placeholder="r2://bucket/video.mp4"
                className="min-h-[100px] text-sm font-mono"
              />
              <p className="text-[10px] text-muted-foreground">
                Upload your files via the Upload API first, then paste the returned storage keys here.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Step 3 — Features */}
      {step === 3 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Select the production capabilities to apply.</p>
          <div className="space-y-2">
            {FEATURES.map((feat) => {
              const on = features.has(feat.id);
              return (
                <button
                  key={feat.id}
                  type="button"
                  onClick={() => toggleFeature(feat.id)}
                  className={cn(
                    'w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors',
                    on ? 'border-primary bg-primary/5' : 'border-border hover:border-border/80',
                  )}
                >
                  <span className={cn(
                    'w-4 h-4 rounded border shrink-0 flex items-center justify-center text-[10px] font-bold',
                    on ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/30',
                  )}>
                    {on ? '✓' : ''}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-tight">{feat.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{feat.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 4 — Platform, Publish, Add-ons */}
      {step === 4 && (
        <div className="space-y-5">
          {/* Platforms */}
          <div className="space-y-2">
            <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Platforms</Label>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => togglePlatform(p.id)}
                  className={cn(
                    'px-3 py-1.5 text-xs rounded-md border transition-colors',
                    platforms.includes(p.id)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Schedule */}
          <SchedulePicker platforms={platforms} value={schedule} onChange={setSchedule} />

          {/* Add-ons */}
          <div className="space-y-2">
            <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Add-on extensions</Label>
            <div className="space-y-2">
              {ADD_ONS.map((ao) => {
                const on = addOns.has(ao.id);
                return (
                  <button
                    key={ao.id}
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
                    )}>
                      {on ? '✓' : ''}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-tight">{ao.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{ao.description}</p>
                    </div>
                    <Badge variant="secondary" className="text-[10px] shrink-0">{ao.badge}</Badge>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Summary */}
          <Card className="bg-muted/30 border-dashed">
            <CardContent className="pt-4 space-y-2 text-xs text-muted-foreground">
              <p><span className="font-medium text-foreground">Format:</span> {formFactor === 'long' ? 'Long-form (16:9)' : 'Short-form (9:16)'}</p>
              <p><span className="font-medium text-foreground">Path:</span> {selectedPathConfig?.label}</p>
              <p><span className="font-medium text-foreground">Source:</span> {effectiveSource === 'fetch' ? 'Fetch from URLs' : 'Upload files'}</p>
              <p><span className="font-medium text-foreground">Features:</span> {Array.from(features).map((id) => FEATURES.find((f) => f.id === id)?.label).join(', ') || 'None'}</p>
              <p><span className="font-medium text-foreground">Platforms:</span> {platforms.join(', ')}</p>
              {addOns.size > 0 && <p><span className="font-medium text-foreground">Add-ons:</span> {Array.from(addOns).join(', ')}</p>}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      <Separator />

      {/* Navigation */}
      <div className="flex gap-2 justify-between">
        <button
          type="button"
          onClick={() => step === 0 ? router.back() : setStep((s) => (s - 1) as Step)}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        >
          {step === 0 ? 'Cancel' : '← Back'}
        </button>
        <Button
          size="sm"
          disabled={isPending}
          onClick={advance}
        >
          {isPending ? 'Submitting…' : step === 4 ? 'Submit job' : 'Next →'}
        </Button>
      </div>
    </div>
  );
}
