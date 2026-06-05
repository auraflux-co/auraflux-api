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
  FeatureCategoryBox,
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

const DUR_TO_MINS: Record<string, number> = {
  '15s': 0.25, '30s': 0.5, '60s': 1, '90s': 1.5,
  '5min': 5, '10min': 10, '15min': 15, '30min': 30,
};

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
  { id: 'none',    label: 'None'    },
  { id: 'warm',    label: 'Warm'    },
  { id: 'cool',    label: 'Cool'    },
  { id: 'neut',    label: 'Neutral' },
  { id: 'vivid',   label: 'Vivid'   },
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
    description: 'Writes a structured video script from your source material',
    tooltip: 'Analyses your source and writes a structured script — intro, key segments, and a close.',
    outputImpact: 'Your video gets a structured script — intro, key segments, and a close.',
    default: true, formFactors: ['long'], hasConfig: true, category: 'content', status: 'live',
  },
  {
    id: 'tts', label: 'Add voiceover',
    description: 'Professional voice narrates the generated script',
    tooltip: 'A professional voice reads your script — no recording needed.',
    outputImpact: 'A professional voice reads your script — no recording needed.',
    default: false, formFactors: ['long'], requires: ['script'], hasConfig: true, advanced: true,
    category: 'content', status: 'live',
  },
  {
    id: 'commentary', label: 'Add commentary overlay',
    description: 'Narrative text commentary timed to footage',
    tooltip: 'Structured text commentary appears on screen, timed to the footage — like a sports broadcast overlay.',
    outputImpact: 'Commentary text appears timed to key moments.',
    default: false, formFactors: ['long'], hasConfig: true, advanced: true,
    category: 'content', status: 'live',
  },
  {
    id: 'generation', label: 'Generate missing footage',
    description: 'Generated clips fill gaps in your footage',
    tooltip: 'Where your source footage has gaps, matching video clips are generated to fill them.',
    outputImpact: 'Gaps in footage are filled with generated clips.',
    default: false, formFactors: ['long'], hasConfig: true, advanced: true,
    category: 'content', status: 'live',
  },
  {
    id: 'scene_select', label: 'Auto-select clips',
    description: 'Auto-selects the best clips from your source',
    tooltip: 'Every clip is scored for energy and relevance — only the best segments are kept, no manual trimming needed.',
    outputImpact: 'Only the most relevant segments are used — weak clips are cut.',
    default: true, formFactors: ['long', 'short'], hasConfig: false, category: 'editing', status: 'live',
  },
  {
    id: 'burn_images', label: 'Add images',
    description: 'Place images into your video',
    tooltip: 'Embed images as timed segments in the assembled video at any position.',
    outputImpact: 'Your images appear in the video at the position and duration you specify.',
    default: false, formFactors: ['long', 'short'], hasConfig: true, advanced: true,
    category: 'editing', status: 'live',
  },
  {
    id: 'dynamic', label: 'Add animated overlays',
    description: 'Animated text, scoreboards, and motion graphics',
    tooltip: 'Live data overlays — scores, stats, headlines — animated in your brand style.',
    outputImpact: 'Live data overlays are animated into the video using your brand style.',
    default: false, formFactors: ['long', 'short'], hasConfig: false, category: 'effects', status: 'live',
  },
  {
    id: 'branding', label: 'Add branded intro/outro',
    description: 'Add your brand style across the video',
    tooltip: 'Opens and closes your video with a branded sequence — your logo, colours, and any custom stinger you\'ve set up.',
    outputImpact: 'Your brand logo, colour palette, and lower-third templates are applied.',
    default: true, formFactors: ['long', 'short'], hasConfig: false, category: 'brand', status: 'live',
  },
  {
    id: 'lower_thirds', label: 'Add speaker captions',
    description: 'Name plates on screen when a speaker appears',
    tooltip: 'Adds a name caption to the bottom of the screen for each clip segment — like a news broadcast lower third.',
    outputImpact: 'Speaker name plates appear on each clip segment.',
    default: false, formFactors: ['long', 'short'], hasConfig: false, category: 'effects', status: 'live', requires: [],
  },
  {
    id: 'chapter_markers', label: 'Add chapter markers',
    description: 'Auto timestamp chapters in YouTube description',
    tooltip: 'When you publish to YouTube, chapter markers are added automatically so viewers can skip to any section.',
    outputImpact: 'Auto-generated timestamp chapters are added to the YouTube description.',
    default: false, formFactors: ['long'], hasConfig: false, category: 'brand', status: 'live', requires: [],
  },
  {
    id: 'scene_transitions', label: 'Add scene transitions',
    description: 'Smooth visual blend between clips',
    tooltip: 'Adds a smooth visual blend between each clip so the video doesn\'t jump-cut.',
    outputImpact: 'Smooth crossfades are applied between every clip.',
    default: false, formFactors: ['long', 'short'], hasConfig: false, category: 'editing', status: 'live', requires: [],
  },
  {
    id: 'shoppable', label: 'Shoppable CTA overlay',
    description: 'Add a tappable buy button to your video',
    tooltip: 'Overlays a branded CTA button at the bottom of your video — link viewers to a product, offer, or page.',
    outputImpact: 'A tappable CTA is burned into the video at the position you choose.',
    default: false, formFactors: ['long', 'short'], hasConfig: true, advanced: true, category: 'brand', status: 'live',
  },
  {
    id: 'pip', label: 'Face-cam overlay (PiP)',
    description: 'Overlay your face-cam in a corner of the video',
    tooltip: 'Upload a reaction or commentary clip and it\'s overlaid as a picture-in-picture in the corner.',
    outputImpact: 'Your face-cam appears in a corner — great for commentary or reaction videos.',
    default: false, formFactors: ['long', 'short'], hasConfig: true, advanced: true, category: 'effects', status: 'live',
  },
  {
    id: 'i2v', label: 'Image-to-video generation',
    description: 'Generate video starting from your reference image',
    tooltip: 'Provide a reference image and WAN i2v generates video footage that begins from that exact frame.',
    outputImpact: 'Missing footage is generated starting from your reference image — not a blank prompt.',
    default: false, formFactors: ['long', 'short'], hasConfig: true, advanced: true, category: 'content',
    minPlan: 'managed', status: 'live',
  },
  {
    id: 'imagen', label: 'Imagen 3 thumbnails',
    description: 'AI-designed thumbnail options powered by Google Imagen 3',
    tooltip: 'Generates polished branded thumbnails using Google Imagen 3 — shown alongside frame and designed options in the thumbnail picker.',
    outputImpact: 'Imagen 3 thumbnail candidates appear in the thumbnail picker for you to choose from.',
    default: false, formFactors: ['long', 'short'], hasConfig: false, advanced: true, category: 'brand',
    minPlan: 'managed', status: 'live',
  },
];

const CATEGORY_BOXES: CategoryBox[] = [
  { id: 'content',  label: 'Content & Script',  description: 'Script writing, voiceover, and commentary', icon: '✍️', formFactors: ['long'] },
  { id: 'editing',  label: 'Editing & Pacing',  description: 'Smart cuts, clip selection, and timing',       icon: '✂️', formFactors: ['long', 'short'] },
  { id: 'effects',  label: 'Effects & Captions', description: 'Overlays, animations, and on-screen text',    icon: '✨', formFactors: ['long', 'short'] },
  { id: 'brand',    label: 'Design & Brand',    description: 'Thumbnails, intros, and brand identity',       icon: '🎨', formFactors: ['long', 'short'] },
];

const ALL_SECTIONS = ['type', 'source', 'format', 'platform', 'production', 'schedule', 'publish_settings'];

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

// ─── FeatureConfigPanel (module scope — prevents remount on every state change) ─

interface FeatureConfigPanelProps {
  feat:          Feature;
  cfg:           Record<string, string>;
  tone:          string;
  setTone:       (v: string) => void;
  setFeatureCfg: (fid: string, key: string, value: string) => void;
}

function FeatureConfigPanel({ feat, cfg, tone, setTone, setFeatureCfg }: FeatureConfigPanelProps) {
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
      {feat.id === 'shoppable' && (
        <>
          <div className="space-y-1.5">
            <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Button text</Label>
            <input type="text" maxLength={40}
              value={cfg.ctaText ?? 'Shop now'} onChange={(e) => setFeatureCfg('shoppable', 'ctaText', e.target.value)}
              placeholder="Shop now"
              className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Destination URL</Label>
            <input type="url"
              value={cfg.ctaUrl ?? ''} onChange={(e) => setFeatureCfg('shoppable', 'ctaUrl', e.target.value)}
              placeholder="https://yourstore.com/product"
              className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Position</Label>
            <select value={cfg.position ?? 'bottom-center'} onChange={(e) => setFeatureCfg('shoppable', 'position', e.target.value)}
              className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
              <option value="bottom-center">Bottom centre</option>
              <option value="bottom-left">Bottom left</option>
              <option value="bottom-right">Bottom right</option>
            </select>
          </div>
        </>
      )}
      {feat.id === 'pip' && (
        <div className="space-y-1.5">
          <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Face-cam position</Label>
          <select value={cfg.position ?? 'bottom-right'} onChange={(e) => setFeatureCfg('pip', 'position', e.target.value)}
            className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary">
            <option value="bottom-right">Bottom right (default)</option>
            <option value="bottom-left">Bottom left</option>
            <option value="top-right">Top right</option>
            <option value="top-left">Top left</option>
          </select>
          <p className="text-[10px] text-muted-foreground">Upload your face-cam clip in the Source section above (secondary video input).</p>
        </div>
      )}
      {feat.id === 'i2v' && (
        <div className="space-y-1.5">
          <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Reference image URL</Label>
          <input type="url"
            value={cfg.imageUrl ?? ''} onChange={(e) => setFeatureCfg('i2v', 'imageUrl', e.target.value)}
            placeholder="https://… or leave blank to use first video frame"
            className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary" />
          <p className="text-[10px] text-muted-foreground">The video generator starts from this image. If blank, the first frame of your source footage is used.</p>
        </div>
      )}
    </div>
  );
}

// ─── FeatureRow (module scope — prevents remount on every state change) ────────

interface FeatureRowProps {
  feat:          Feature;
  features:      Set<string>;
  featureConfig: Record<string, Record<string, string>>;
  toggleFeature: (id: string) => void;
  tier:          PlanTier;
  tone:          string;
  setTone:       (v: string) => void;
  setFeatureCfg: (fid: string, key: string, value: string) => void;
}

function FeatureRow({ feat, features, featureConfig, toggleFeature, tier, tone, setTone, setFeatureCfg }: FeatureRowProps) {
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
      {on && <FeatureConfigPanel feat={feat} cfg={cfg} tone={tone} setTone={setTone} setFeatureCfg={setFeatureCfg} />}
    </div>
  );
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
  const [scheduledStart, setScheduledStart] = useState<'now' | 'scheduled'>('now');
  const [scheduledAt,    setScheduledAt]    = useState('');
  // CPD-511/513: publish mode + optional metadata override
  const [publishMode,    setPublishMode]    = useState<'immediate' | 'review'>('immediate');
  const [pubTitle,       setPubTitle]       = useState('');
  const [pubDescription, setPubDescription] = useState('');
  const [pubTags,           setPubTags]           = useState('');
  const [pubPrivacy,        setPubPrivacy]        = useState<'public' | 'unlisted' | 'private'>('public');
  const [pubTiktokCaption,  setPubTiktokCaption]  = useState('');
  const [pubInstagramCaption, setPubInstagramCaption] = useState('');
  const [tone,           setTone]           = useState('professional');
  const [shoppableCtaText, setShoppableCtaText] = useState('Shop now');
  const [shoppableCtaUrl,  setShoppableCtaUrl]  = useState('');
  const [pipVideoFile,   setPipVideoFile]   = useState<File | null>(null);
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

  // When a preset template is active, this holds the original template object so the
  // production section can distinguish "included by template" from "optional extras".
  const activeTemplate = templateId !== 'custom'
    ? PRESET_TEMPLATES.find((t) => t.id === templateId) ?? null
    : null;

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
        const si = spec.sourceIntent as 'clips' | 'longform' | undefined;
        if (si) setSourceIntent(si);
        const fmt = spec.format as string | undefined;
        if (fmt) setFormat(fmt);
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
    setFeatures((prev) => {
      const n = new Set(prev);
      if (n.has(id)) {
        n.delete(id);
        // Cascade: deselect anything that required this feature
        for (const f of FEATURES) {
          if (f.requires?.includes(id) && n.has(f.id)) n.delete(f.id);
        }
      } else {
        n.add(id);
      }
      return n;
    });
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

    // Build addOns from the wizard's collected state so dashboard and API jobs
    // are always equivalent — matches the canonical feature_input_schema on the server.
    const addOns: CreateJobPayload['addOns'] = {};
    if (captions) {
      addOns.captions = { active: true, style: 'animated' };
    }
    if (grade && grade !== 'none') {
      addOns.colorGrade = { active: true, preset: grade as 'vivid' | 'warm' | 'cool' | 'moody' | 'crisp' | 'neut' };
    }
    if (effects.length > 0) {
      const effObj: Record<string, boolean> = {};
      for (const e of effects) effObj[e] = true;
      addOns.effects = effObj as { zoom?: boolean; transitions?: boolean; slowmo?: boolean; vignette?: boolean };
    }
    if (audioOpts.length > 0) {
      const audioObj: Record<string, boolean> = {};
      for (const a of audioOpts) audioObj[a] = true;
      addOns.audio = audioObj as { loudnorm?: boolean; duck?: boolean; denoise?: boolean };
    }
    if (features.has('shoppable')) {
      const shopCfg = featureConfig['shoppable'] ?? {};
      if (shopCfg.ctaUrl?.trim()) {
        addOns.shoppable = {
          active:   true,
          ctaText:  shopCfg.ctaText?.trim() || 'Shop now',
          ctaUrl:   shopCfg.ctaUrl.trim(),
          position: (shopCfg.position || 'bottom-center') as 'bottom-center' | 'bottom-left' | 'bottom-right',
        };
      }
    }
    if (features.has('pip')) {
      const pipCfg = featureConfig['pip'] ?? {};
      addOns.pip = {
        active:   true,
        position: (pipCfg.position || 'bottom-right') as 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left',
      };
    }
    if (features.has('i2v')) {
      const i2vCfg = featureConfig['i2v'] ?? {};
      addOns.i2v = {
        active:   true,
        imageUrl: i2vCfg.imageUrl?.trim() || undefined,
      };
    }
    if (features.has('imagen')) {
      addOns.imagen = { active: true };
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
      addOns:         Object.keys(addOns).length > 0 ? addOns : undefined,
      // CPD-511/513: staging gate + customer-provided publish metadata
      staging:        publishMode === 'review' ? true : undefined,
      publishMeta: (() => {
        const pm: CreateJobPayload['publishMeta'] = {};
        if (pubTitle.trim())       pm.title         = pubTitle.trim();
        if (pubDescription.trim()) pm.description   = pubDescription.trim();
        if (pubTags.trim())        pm.tags           = pubTags.split(',').map((t) => t.trim()).filter(Boolean);
        if (pubPrivacy !== 'public')         pm.privacyStatus    = pubPrivacy;
        if (pubTiktokCaption.trim())          pm.tiktokCaption    = pubTiktokCaption.trim();
        if (pubInstagramCaption.trim())       pm.instagramCaption = pubInstagramCaption.trim();
        return Object.keys(pm).length ? pm : undefined;
      })(),
    };

    if (sourceMode === 'source') {
      payload.fetchSpec = {
        sourceUrls:    sourceItems.map((i) => i.url),
        stitchMode:    inferredMultiClip && sourceItems.length > 1,
        sourceLibrary: sourceItems.map((i) => ({
          url:          i.url,
          title:        i.title,
          duration:     i.duration,
          thumbnailUrl: i.thumbnailUrl ?? undefined,
          platform:     i.platform,
          contentType:  i.contentType || i.type,
        })),
        // ClipEditor output: trim/extract timestamps, clip order, per-clip overrides
        ...(clipSpec ? { clipSpec: {
          mode:             clipSpec.mode,
          clips:            clipSpec.clips,
          uniformFeatures:  clipSpec.uniformFeatures,
          featureOverrides: clipSpec.featureOverrides,
        } } : {}),
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
        const brandingDisabled = res.warnings?.some((w) => w.code === 'BRANDING_NO_LOGO');
        if (brandingDisabled) {
          toast.warning('Branding skipped', {
            description: 'Upload a logo to enable branding. Your video will be produced without brand overlays.',
            duration: 8000,
          });
        } else {
          toast.success('Production started', {
            description: 'Your video is now building. Track progress on the job page.',
            duration: 5000,
          });
        }
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
      ? (formFactor === 'short' ? 'Find highlights' : 'Create a full video')
      : (inferredMultiClip ? 'Make a longer video' : formFactor === 'short' ? 'Polish short clips' : ''),
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
    production: features.size === 0 ? 'Default'
      : Array.from(features).map((f) => FEATURES.find((x) => x.id === f)?.label ?? f).join(' · '),
    schedule: scheduledStart === 'now' ? 'Start now' : scheduledAt ? `Scheduled: ${scheduledAt}` : '',
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl space-y-0">

      {/* Submitting overlay */}
      {isPending && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm font-medium">Starting production…</p>
            <p className="text-xs text-muted-foreground">You'll be taken to your job page in a moment.</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-4">
        <div>
          <h1 className="text-2xl font-semibold">
            <span className="bg-gradient-to-r from-foreground to-foreground/80 bg-clip-text">Create a video</span>
            <span className="ml-2 text-xl">✨</span>
          </h1>
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
            {isPending ? 'Starting…' : canSubmit ? 'Start production →' : 'Complete required steps'}
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
            <div className="flex items-center gap-3 rounded-lg border border-primary/30 px-4 py-2.5 mb-4 bg-primary/5">
              {templateId === 'custom'
                ? <>
                    <span className="text-base">🛠️</span>
                    <span className="text-sm font-medium">Building from scratch</span>
                  </>
                : (() => {
                    const t = PRESET_TEMPLATES.find((x) => x.id === templateId);
                    const ICONS: Record<string, string> = {
                      tiktok_clutch: '⚡', youtube_deep_dive: '🎬', irl_story_time: '💬',
                      montage_hype_reel: '🔥', reaction_cut: '😂', quick_guide: '🎯',
                    };
                    return <>
                      <span className="text-base shrink-0">{ICONS[templateId] ?? '▶'}</span>
                      <Badge variant="outline" className="border-primary/40 text-primary text-[11px]">
                        {t?.label ?? templateBanner ?? 'Saved template'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">Pre-configured — change any section below</span>
                    </>;
                  })()
              }
              <button type="button" onClick={changeTemplate}
                      className="ml-auto text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                Change template
              </button>
            </div>
          )}

          {templatePicked && (
            <div className="space-y-1">

              {/* TYPE — hidden when a template is active (template already defines this) */}
              {!activeTemplate && <CollapsibleSection id="type" label="What are you making?" required
                summary={summaries.type} open={isOpen('type')} onToggle={() => toggle('type')}>
                <div className="space-y-3">
                  <ChipGroup
                    options={[
                      { id: 'short_clips',  label: 'Polish short clips',  sub: 'Turn clips into finished Shorts/Reels' },
                      { id: 'long_compile', label: 'Make a longer video', sub: 'Combine clips into one YouTube video' },
                      { id: 'from_vod',     label: 'Find highlights',     sub: 'Pull standout moments from long footage' },
                      { id: 'produce_vod',  label: 'Create a full video', sub: 'Add script, narration, and structure' },
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
                      // Prune features that don't apply to the new formFactor
                      setFeatures((prev) => new Set([...prev].filter((fid) => {
                        const feat = FEATURES.find((f) => f.id === fid);
                        return feat ? feat.formFactors.includes(ff) : true;
                      })));
                      setSourceItems([]); setClipSpec(null); setShowClipEditor(false);
                    }}
                    singleSelect
                  />
                </div>
              </CollapsibleSection>}

              {!activeTemplate && <div className="h-px bg-border/50 my-0.5" />}

              {/* SOURCE */}
              <CollapsibleSection id="source" label="Source video" required
                summary={summaries.source} open={isOpen('source')} onToggle={() => toggle('source')}>
                <div className="space-y-4">
                  {/* Tab bar */}
                  <div className="flex gap-2">
                    {(['source', 'upload'] as SourceMode[]).map((s) => {
                      const labels: Record<SourceMode, string> = { source: 'Browse your channels', upload: 'Upload a file' };
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
                          Let AuraFlux choose
                        </button>
                      </div>
                      <ClipEditor
                        mode={sourceIntent === 'longform' ? 'extract' : 'compact'}
                        sourceUrl={sourceIntent === 'longform' ? (sourceItems[0]?.url ?? undefined) : undefined}
                        sourceClips={sourceIntent !== 'longform'
                          ? sourceItems.map((i) => ({ url: i.url, title: i.title, duration: i.duration ?? undefined, thumbnailUrl: i.thumbnailUrl ?? undefined }))
                          : undefined}
                        availableFeatures={Array.from(features)}
                        onConfirm={(spec) => {
                          setClipSpec(spec);
                          setDurationMins(calcDuration(spec));
                          setShowClipEditor(false);
                          // Auto-collapse Source section — clips are confirmed
                          setOpenSections((prev) => prev.filter((s) => s !== 'source'));
                        }}
                        onCancel={() => {
                          setClipSpec(null);
                          setDurationMins(calcDuration(null));
                          setShowClipEditor(false);
                          setOpenSections((prev) => prev.filter((s) => s !== 'source'));
                        }}
                      />
                    </div>
                  )}
                </div>
              </CollapsibleSection>

              <div className="h-px bg-border/50 my-0.5" />

              {/* FORMAT — hidden when template is active (template defines format + duration) */}
              {!activeTemplate && <CollapsibleSection id="format" label="Format" required
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
                        onToggle={(id) => { setDuration(id); setDurationMins(DUR_TO_MINS[id] ?? 1); }} />
                    </div>
                  )}
                </div>
              </CollapsibleSection>}

              {!activeTemplate && <div className="h-px bg-border/50 my-0.5" />}

              {/* PLATFORM */}
              <CollapsibleSection id="platform" label="Where to publish" required
                summary={summaries.platform} open={isOpen('platform')} onToggle={() => toggle('platform')}>
                <ChipGroup options={PLATFORMS} selected={platforms}
                  onToggle={(id) => setPlatforms((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])} />
              </CollapsibleSection>

              <div className="h-px bg-border/50 my-0.5" />

              {/* PRODUCTION FEATURES */}
              <CollapsibleSection id="production"
                label={activeTemplate ? 'Optional extras' : 'Production add-ons'}
                summary={summaries.production} open={isOpen('production')} onToggle={() => toggle('production')}>
                <div className="space-y-4">

                  {/* ── Included by template summary ── */}
                  {activeTemplate && (() => {
                    const GRADE_LABELS: Record<string, string> = { vivid: 'Vivid color', neut: 'Neutral color', warm: 'Warm color', cool: 'Cool color' };
                    const EFFECT_LABELS: Record<string, string> = { zoom: 'Zoom cuts', transitions: 'Scene transitions' };
                    const AUDIO_LABELS: Record<string, string>  = { loudnorm: 'Volume balance', duck: 'Music ducking' };
                    const FEAT_LABELS: Record<string, string>   = { scene_select: 'Auto-select clips', branding: 'Branded intro/outro' };
                    const FORMAT_LABELS: Record<string, string> = { portrait: '9:16 portrait', longform: '16:9 landscape' };
                    const pills: string[] = [
                      FORMAT_LABELS[activeTemplate.format] ?? activeTemplate.format,
                      ...(activeTemplate.captions ? ['Captions'] : []),
                      ...(GRADE_LABELS[activeTemplate.grade] ? [GRADE_LABELS[activeTemplate.grade]] : []),
                      ...activeTemplate.effects.flatMap((e) => EFFECT_LABELS[e] ? [EFFECT_LABELS[e]] : []),
                      ...activeTemplate.audioOpts.flatMap((a) => AUDIO_LABELS[a] ? [AUDIO_LABELS[a]] : []),
                      ...activeTemplate.features.flatMap((f) => FEAT_LABELS[f] ? [FEAT_LABELS[f]] : []),
                    ];
                    return (
                      <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 space-y-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-primary/70">
                          Included by {activeTemplate.label} template
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {pills.map((pill) => (
                            <span key={pill}
                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                              ✓ {pill}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Optional output add-ons (not set by template) ── */}
                  {(!activeTemplate?.captions || !activeTemplate?.voiceover) && (
                    <div className="space-y-2">
                      {!activeTemplate && (
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Output options</p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {!activeTemplate?.captions && (
                          <button type="button" onClick={() => setCaptions(!captions)}
                            className={cn('text-left rounded-lg border px-3 py-2 transition-colors min-w-[140px]',
                              captions ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:border-primary/40')}>
                            <p className="text-sm font-medium">Captions</p>
                            <p className={cn('text-[11px] mt-0.5', captions ? 'text-primary-foreground/70' : 'text-muted-foreground')}>Added directly to the video</p>
                          </button>
                        )}
                        {!activeTemplate?.voiceover && (
                          <button type="button" onClick={() => { toggleFeature('tts'); setVoiceover(!voiceover); }}
                            className={cn('text-left rounded-lg border px-3 py-2 transition-colors min-w-[140px]',
                              features.has('tts') ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:border-primary/40')}>
                            <p className="text-sm font-medium">Voiceover</p>
                            <p className={cn('text-[11px] mt-0.5', features.has('tts') ? 'text-primary-foreground/70' : 'text-muted-foreground')}>Script narration</p>
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── Visual style — only shown in Build My Own ── */}
                  {!activeTemplate && (
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
                  )}

                  {/* ── Audio — only shown in Build My Own ── */}
                  {!activeTemplate && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Audio</p>
                      <ChipGroup options={AUDIO_OPTS} selected={audioOpts}
                        onToggle={(id) => setAudioOpts((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])} />
                    </div>
                  )}

                  {/* ── Production tools: extras not already in the template ── */}
                  {formFactor && CATEGORY_BOXES.some((cat) =>
                    FEATURES.some((f) => f.category === cat.id && f.status === 'live'
                      && f.formFactors.includes(formFactor) && !(activeTemplate?.features.includes(f.id)))
                  ) && (
                    <div className="space-y-2">
                      {!activeTemplate && (
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          Production tools
                        </p>
                      )}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {CATEGORY_BOXES.map((cat) => {
                          const catFeatures = FEATURES.filter(
                            (f) => f.category === cat.id
                              && f.status === 'live'
                              && f.formFactors.includes(formFactor)
                              && !(activeTemplate?.features.includes(f.id)),
                          );
                          if (catFeatures.length === 0) return null;
                          return (
                            <FeatureCategoryBox
                              key={cat.id}
                              category={cat}
                              features={catFeatures}
                              allFeatures={FEATURES}
                              selected={features}
                              onToggle={toggleFeature}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Config panels for enabled features */}
                  {Array.from(features)
                    .map((fid) => FEATURES.find((f) => f.id === fid))
                    .filter((f): f is Feature => !!f && f.hasConfig)
                    .map((feat) => (
                      <FeatureRow
                        key={feat.id}
                        feat={feat}
                        features={features}
                        featureConfig={featureConfig}
                        toggleFeature={toggleFeature}
                        tier={tier}
                        tone={tone}
                        setTone={setTone}
                        setFeatureCfg={setFeatureCfg}
                      />
                    ))}

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
              <CollapsibleSection id="schedule" label="When to start"
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

              <div className="h-px bg-border/50 my-0.5" />

              {/* PUBLISH SETTINGS — CPD-511/513 */}
              <CollapsibleSection id="publish_settings" label="Publish settings"
                summary={publishMode === 'review' ? 'Review before publishing' : pubTitle ? `Title: ${pubTitle.slice(0, 32)}` : 'Publish immediately'}
                open={isOpen('publish_settings')} onToggle={() => toggle('publish_settings')}>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs mb-1.5 block">After production</Label>
                    <ChipGroup
                      options={[
                        { id: 'immediate', label: 'Publish immediately' },
                        { id: 'review',    label: 'Review before publishing' },
                      ]}
                      selected={[publishMode]}
                      singleSelect
                      onToggle={(id) => setPublishMode(id as 'immediate' | 'review')}
                    />
                    {publishMode === 'review' && (
                      <p className="text-[11px] text-muted-foreground mt-1.5">
                        Your video will be held for review. You&apos;ll approve and publish from the job detail page.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Publish metadata <span className="font-normal">(optional — auto-filled if left blank)</span>
                    </Label>
                    <input
                      type="text"
                      placeholder="Video title"
                      value={pubTitle}
                      onChange={(e) => setPubTitle(e.target.value)}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <textarea
                      placeholder="Description"
                      value={pubDescription}
                      onChange={(e) => setPubDescription(e.target.value)}
                      rows={2}
                      className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                    <div className="space-y-1">
                      <input
                        type="text"
                        placeholder="Tags (comma-separated)"
                        value={pubTags}
                        onChange={(e) => setPubTags(e.target.value)}
                        className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <p className="text-[10px] text-muted-foreground">No # needed — e.g. gaming, twitch, highlights</p>
                    </div>
                    {/* Visibility is YouTube-specific — hide when YouTube is not selected */}
                    {platforms.includes('youtube') && (
                      <div className="flex items-center gap-2">
                        <Label className="text-xs shrink-0">Visibility</Label>
                        <select
                          value={pubPrivacy}
                          onChange={(e) => setPubPrivacy(e.target.value as typeof pubPrivacy)}
                          className="text-sm border rounded-md px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <option value="public">Public</option>
                          <option value="unlisted">Unlisted</option>
                          <option value="private">Private</option>
                        </select>
                      </div>
                    )}

                    {/* TikTok-specific caption — shown only when TikTok is a selected platform */}
                    {platforms.includes('tiktok') && (
                      <div className="space-y-1 pt-1 border-t">
                        <Label className="text-xs text-muted-foreground flex items-center gap-1">
                          <span>🎵</span> TikTok caption <span className="font-normal">(max 280 chars — auto-filled if blank)</span>
                        </Label>
                        <textarea
                          placeholder="TikTok caption + hashtags"
                          value={pubTiktokCaption}
                          onChange={(e) => setPubTiktokCaption(e.target.value.slice(0, 280))}
                          rows={2}
                          maxLength={280}
                          className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                        />
                        <p className="text-[10px] text-muted-foreground text-right">{pubTiktokCaption.length}/280</p>
                      </div>
                    )}

                    {/* Instagram-specific caption — shown only when Instagram is a selected platform */}
                    {platforms.includes('instagram') && (
                      <div className="space-y-1 pt-1 border-t">
                        <Label className="text-xs text-muted-foreground flex items-center gap-1">
                          <span>📸</span> Instagram caption <span className="font-normal">(max 2200 chars — auto-filled if blank)</span>
                        </Label>
                        <textarea
                          placeholder="Instagram caption + hashtags"
                          value={pubInstagramCaption}
                          onChange={(e) => setPubInstagramCaption(e.target.value.slice(0, 2200))}
                          rows={3}
                          maxLength={2200}
                          className="w-full text-sm border rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                        />
                        <p className="text-[10px] text-muted-foreground text-right">{pubInstagramCaption.length}/2200</p>
                      </div>
                    )}
                  </div>
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
              grade={grade as 'none' | 'warm' | 'cool' | 'neut' | 'vivid'}
              effects={effects}
            />

            {/* Expected output summary — visible as soon as template is picked */}
            <div className="space-y-1.5 border-t border-border pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">What you&apos;ll get</p>
              {[
                format && FORMATS.find((f) => f.id === format)?.label,
                !isLongForm && duration && durLabel(duration),
                platforms.length > 0 && platforms.map((p) => PLATFORMS.find((x) => x.id === p)?.label ?? p).join(' · '),
                captions && 'Burnt-in captions',
                voiceover && 'Voiceover narration',
                grade !== 'none' && `${(GRADES.find((g) => g.id === grade)?.label ?? grade)} color grade`,
                effects.length > 0 && effects.map((e) => EFFECTS_OPTS.find((x) => x.id === e)?.label ?? e).join(' + '),
                features.size > 0 && Array.from(features)
                  .map((fid) => FEATURES.find((f) => f.id === fid)?.label)
                  .filter(Boolean)
                  .join(', '),
                canSubmit && `${estimate.credits} credits`,
              ].filter(Boolean).map((line, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <div className="w-1 h-1 rounded-full bg-primary shrink-0 mt-1.5" />
                  <span>{String(line)}</span>
                </div>
              ))}
              {!format && !platforms.length && (
                <p className="text-[11px] text-muted-foreground italic">Complete the sections above to see your output summary.</p>
              )}
            </div>

            <Button size="sm" className="w-full" disabled={!canSubmit || isPending} onClick={handleSubmit}>
              {isPending ? 'Starting…' : canSubmit ? 'Start production →' : 'Complete required steps'}
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
