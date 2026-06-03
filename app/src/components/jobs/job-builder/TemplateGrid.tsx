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

// Per-template accent: icon + top-bar gradient + selected ring
const TEMPLATE_ACCENT: Record<string, {
  icon:     string;
  bar:      string;   // top accent bar color
  ring:     string;   // selected border/ring
  bg:       string;   // selected background tint
  pill:     string;   // output-form badge colors
}> = {
  tiktok_clutch:     { icon: '⚡', bar: 'bg-violet-500',  ring: 'border-violet-500',  bg: 'bg-violet-500/8',  pill: 'bg-violet-500/15 text-violet-400 border-violet-500/30' },
  youtube_deep_dive: { icon: '🎬', bar: 'bg-blue-500',    ring: 'border-blue-500',    bg: 'bg-blue-500/8',    pill: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  irl_story_time:    { icon: '💬', bar: 'bg-amber-500',   ring: 'border-amber-500',   bg: 'bg-amber-500/8',   pill: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  montage_hype_reel: { icon: '🔥', bar: 'bg-orange-500',  ring: 'border-orange-500',  bg: 'bg-orange-500/8',  pill: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
  reaction_cut:      { icon: '😂', bar: 'bg-teal-500',    ring: 'border-teal-500',    bg: 'bg-teal-500/8',    pill: 'bg-teal-500/15 text-teal-400 border-teal-500/30' },
  quick_guide:       { icon: '🎯', bar: 'bg-green-500',   ring: 'border-green-500',   bg: 'bg-green-500/8',   pill: 'bg-green-500/15 text-green-400 border-green-500/30' },
};

// Fallback for any template not in the accent map
const DEFAULT_ACCENT = { icon: '▶', bar: 'bg-primary', ring: 'border-primary', bg: 'bg-primary/8', pill: 'bg-primary/15 text-primary border-primary/30' };

// Customer-facing output format labels
const OUTPUT_FORM: Record<string, string> = {
  portrait: 'Short-form',
  longform: 'Long-form',
};

function templatePills(t: JobTemplate): string[] {
  const pills: string[] = [];
  const aspect = t.format === 'longform' ? '16:9 landscape' : '9:16 portrait';
  pills.push(aspect);
  if (t.captions) pills.push('Captions');
  if (t.voiceover) pills.push('Voiceover');
  if (t.features.includes('branding')) pills.push('Branded');
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
            const pills       = templatePills(t);
            const platformStr = t.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(', ');
            const accent      = TEMPLATE_ACCENT[t.id] ?? DEFAULT_ACCENT;
            const isSelected  = selectedId === t.id;

            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onApply(t)}
                className={cn(
                  'relative text-left rounded-lg border overflow-hidden transition-all duration-150',
                  isSelected
                    ? cn('border-2', accent.ring, accent.bg, 'shadow-md')
                    : 'border-border hover:border-border/80 hover:bg-muted/20',
                )}
              >
                {/* Top accent bar */}
                <div className={cn('h-1 w-full', accent.bar, !isSelected && 'opacity-40')} />

                <div className="p-3 space-y-2.5">
                  {/* Header row: icon + name + output-form badge */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <span className="text-xl leading-none shrink-0 mt-0.5">{accent.icon}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-tight">{t.label}</p>
                        <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{t.tagline}</p>
                      </div>
                    </div>
                    <span className={cn(
                      'shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap',
                      accent.pill,
                    )}>
                      {OUTPUT_FORM[t.format] ?? t.format}
                    </span>
                  </div>

                  {/* Publishes to */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50 shrink-0">
                      Publishes to
                    </span>
                    <span className="text-[11px] text-foreground/80 truncate">{platformStr}</span>
                  </div>

                  {/* Included feature pills */}
                  <div className="flex flex-wrap gap-1">
                    {pills.map((pill) => (
                      <span
                        key={pill}
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded-full border',
                          isSelected
                            ? cn(accent.pill)
                            : 'bg-muted/60 text-muted-foreground border-border/50',
                        )}
                      >
                        {pill}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Selected checkmark */}
                {isSelected && (
                  <div className={cn(
                    'absolute top-2.5 right-2.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px]',
                    accent.bar,
                  )}>
                    <span className="text-white font-bold leading-none">✓</span>
                  </div>
                )}
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
