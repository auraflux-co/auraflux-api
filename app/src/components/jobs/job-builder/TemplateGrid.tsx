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
    tagline: 'Single high-energy gaming moment — animated captions, vivid grade, zoom',
    formFactor: 'short', sourceIntent: 'clips',
    format: 'portrait', platforms: ['tiktok', 'youtube', 'instagram'],
    captions: true, voiceover: false, grade: 'vivid',
    effects: ['zoom', 'transitions'], audioOpts: ['loudnorm'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'youtube_deep_dive',
    label: 'YouTube Deep Dive',
    tagline: 'VOD trimmed for YouTube — clean captions, landscape, full audio preserved',
    formFactor: 'long', sourceIntent: 'longform',
    format: 'longform', platforms: ['youtube'],
    captions: true, voiceover: false, grade: 'neut',
    effects: ['transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'irl_story_time',
    label: 'IRL Story Time',
    tagline: 'IRL or just-chatting clip — warm grade, face-safe captions, portrait',
    formFactor: 'short', sourceIntent: 'clips',
    format: 'portrait', platforms: ['tiktok', 'instagram'],
    captions: true, voiceover: false, grade: 'warm',
    effects: ['transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'montage_hype_reel',
    label: 'Montage Hype Reel',
    tagline: 'Gaming highlight reel — vivid grade, fast cuts, animated captions',
    formFactor: 'short', sourceIntent: 'clips',
    format: 'portrait', platforms: ['tiktok', 'youtube'],
    captions: true, voiceover: false, grade: 'vivid',
    effects: ['zoom', 'transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'reaction_cut',
    label: 'Reaction Cut',
    tagline: 'Reaction or commentary VOD — neutral grade, clean captions, landscape',
    formFactor: 'long', sourceIntent: 'longform',
    format: 'longform', platforms: ['youtube'],
    captions: true, voiceover: false, grade: 'neut',
    effects: ['zoom', 'transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
  {
    id: 'quick_guide',
    label: 'Quick Guide',
    tagline: 'Educational or tip clip — cool grade, clean centered captions, portrait',
    formFactor: 'short', sourceIntent: 'clips',
    format: 'portrait', platforms: ['youtube', 'tiktok'],
    captions: true, voiceover: false, grade: 'cool',
    effects: ['transitions'], audioOpts: ['loudnorm', 'duck'],
    features: ['scene_select', 'branding'], minClips: 1,
  },
];

interface Props {
  selectedId: string;
  onApply:       (t: JobTemplate) => void;
  onBuildMyOwn:  () => void;
  onChangeTemplate: () => void;
  className?: string;
}

/**
 * Template picker for the single-page job builder (CPD-443).
 * Shows pre-made template cards + a "Build My Own" CTA separated by a divider.
 * Once a template is selected the parent calls onApply() and hides this component,
 * replacing it with a collapsed pill bar; the parent surfaces onChangeTemplate() from
 * that bar to re-show this picker.
 */
export function TemplateGrid({ selectedId, onApply, onBuildMyOwn, className }: Props) {
  return (
    <div className={cn('space-y-4', className)}>
      <div>
        <p className="text-sm font-semibold mb-3">Choose a template</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PRESET_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onApply(t)}
              className={cn(
                'text-left rounded-lg border p-3 transition-colors space-y-1',
                selectedId === t.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/40 hover:bg-muted/30',
              )}
            >
              <p className="text-sm font-semibold leading-tight">{t.label}</p>
              <p className="text-[11px] text-muted-foreground leading-snug">{t.tagline}</p>
            </button>
          ))}
        </div>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold">Build My Own</p>
          <p className="text-xs text-muted-foreground">Not using a template — choose every option yourself</p>
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
