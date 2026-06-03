'use client';

import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';

export interface JobTemplate {
  id:        string;
  label:     string;
  tagline:   string;
  /** Maps to FormFactor */
  formFactor: 'long' | 'short';
  /** Maps to sourceIntent */
  sourceIntent: 'clips' | 'longform';
  format:    string;
  platforms: string[];
  captions:  boolean;
  voiceover: boolean;
  grade:     string;
  effects:   string[];
  audioOpts: string[];
  /** Feature ids to pre-enable */
  features:  string[];
  minClips:  number;
}

export const PRESET_TEMPLATES: JobTemplate[] = [
  {
    id: 'tiktok_clutch',
    label: 'TikTok Clutch',
    tagline: 'Single high-energy gaming moment for short-form platforms',
    formFactor: 'short', sourceIntent: 'clips',
    format: 'portrait', platforms: ['tiktok', 'youtube', 'instagram'],
    captions: true, voiceover: false, grade: 'vivid',
    effects: ['zoom', 'transitions'], audioOpts: ['loudnorm'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'youtube_deep_dive',
    label: 'YouTube Deep Dive',
    tagline: 'Full-length VOD trimmed and polished for YouTube',
    formFactor: 'long', sourceIntent: 'longform',
    format: 'longform', platforms: ['youtube'],
    captions: true, voiceover: false, grade: 'neut',
    effects: ['transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'irl_story_time',
    label: 'IRL Story Time',
    tagline: 'IRL or just-chatting moment for TikTok and Instagram',
    formFactor: 'short', sourceIntent: 'clips',
    format: 'portrait', platforms: ['tiktok', 'instagram'],
    captions: true, voiceover: false, grade: 'warm',
    effects: ['transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'montage_hype_reel',
    label: 'Montage Hype Reel',
    tagline: 'Multi-clip gaming highlight reel with fast cuts',
    formFactor: 'short', sourceIntent: 'clips',
    format: 'portrait', platforms: ['tiktok', 'youtube'],
    captions: true, voiceover: false, grade: 'vivid',
    effects: ['zoom', 'transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'reaction_cut',
    label: 'Reaction Cut',
    tagline: 'Reaction or commentary VOD edited for YouTube',
    formFactor: 'long', sourceIntent: 'longform',
    format: 'longform', platforms: ['youtube'],
    captions: true, voiceover: false, grade: 'neut',
    effects: ['zoom', 'transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'quick_guide',
    label: 'Quick Guide',
    tagline: 'Educational or tip clip for YouTube and TikTok',
    formFactor: 'short', sourceIntent: 'clips',
    format: 'portrait', platforms: ['youtube', 'tiktok'],
    captions: true, voiceover: false, grade: 'cool',
    effects: ['transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
];

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram',
};

// Customer-facing output format labels (not technical aspect ratios)
const OUTPUT_FORM: Record<string, { label: string; color: string }> = {
  portrait: { label: 'Short-form',  color: 'bg-violet-500/15 text-violet-400 border-violet-500/30' },
  longform: { label: 'Long-form',   color: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
};

function templatePills(t: JobTemplate): string[] {
  const pills: string[] = [];
  const aspect = t.format === 'longform' ? '16:9 landscape' : '9:16 portrait';
  pills.push(aspect);
  if (t.captions) pills.push('Captions');
  if (t.voiceover) pills.push('Voiceover');
  if (t.features.includes('branding')) pills.push('Branded intro/outro');
  if (t.effects.includes('zoom')) pills.push('Zoom cuts');
  if (t.effects.includes('transitions')) pills.push('Transitions');
  return pills;
}

interface Props {
  selectedId: string;
  onApply:       (t: JobTemplate) => void;
  onBuildMyOwn:  () => void;
  onChangeTemplate: () => void;
  className?: string;
}

/**
 * Template picker for the single-page job builder (CPD-443 / CPD-498).
 * Cards show what the template produces — format, platforms, and included features.
 */
export function TemplateGrid({ selectedId, onApply, onBuildMyOwn, className }: Props) {
  return (
    <div className={cn('space-y-4', className)}>
      <div>
        <p className="text-sm font-semibold mb-3">Choose a template</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PRESET_TEMPLATES.map((t) => {
            const pills = templatePills(t);
            const platformStr = t.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(', ');
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onApply(t)}
                className={cn(
                  'text-left rounded-lg border p-3 transition-colors space-y-2',
                  selectedId === t.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/40 hover:bg-muted/30',
                )}
              >
                {/* Header: name + short/long-form badge */}
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-sm font-semibold leading-tight">{t.label}</p>
                    <p className="text-[11px] text-muted-foreground leading-snug">{t.tagline}</p>
                  </div>
                  <span className={cn(
                    'shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap',
                    OUTPUT_FORM[t.format]?.color ?? 'bg-muted text-muted-foreground border-border',
                  )}>
                    {OUTPUT_FORM[t.format]?.label ?? t.format}
                  </span>
                </div>
                {/* Publishes to */}
                <div className="space-y-0.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                    Publishes to
                  </p>
                  <p className="text-[11px] text-foreground/80">{platformStr}</p>
                </div>
                {/* Included features */}
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                    Included
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {pills.map((pill) => (
                      <span
                        key={pill}
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/60"
                      >
                        {pill}
                      </span>
                    ))}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold">Build My Own</p>
          <p className="text-xs text-muted-foreground">Choose every option yourself — no template</p>
        </div>
        <button
          type="button"
          onClick={onBuildMyOwn}
          className="shrink-0 text-sm text-primary hover:underline font-medium"
        >
          Start from scratch →
        </button>
      </div>
    </div>
  );
}
