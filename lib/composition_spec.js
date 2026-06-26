'use strict';

const {
  mergeCompCreative,
  compCreativeChips,
  getCompLineupTarget,
  PRESET_LABELS,
  formatCompCreativeSummary,
} = require('./clip_comp_creative');

const SPEC_VERSION = 1;

function clipDurationAfterTrim(clip) {
  const dur = Number(clip.durationHint || clip.duration || 0) || 0;
  const start = clip.trimStart != null ? Number(clip.trimStart) : 0;
  const end = clip.trimEnd != null ? Number(clip.trimEnd) : dur;
  if (end > start) return Math.round(end - start);
  return dur > 0 ? dur : 0;
}

function normalizeClip(clip, index) {
  const dur = Number(clip.durationHint || clip.duration || clip.clipDuration || 60) || 60;
  let trimStart = clip.trimStart != null ? Number(clip.trimStart) : 0;
  let trimEnd = clip.trimEnd != null ? Number(clip.trimEnd) : dur;
  trimStart = Math.max(0, Math.min(trimStart, dur - 1));
  trimEnd = Math.max(trimStart + 1, Math.min(trimEnd, dur));
  return {
    id: clip.id || `clip-${index}`,
    url: clip.url || clip.clipUrl || '',
    pageUrl: clip.pageUrl || clip.url || '',
    title: clip.title || '',
    streamer: clip.streamer || '',
    displayName: clip.displayName || clip.streamer || '',
    order: clip.order != null ? Number(clip.order) : index,
    durationHint: dur,
    trimStart,
    trimEnd,
    thumbnailUrl: clip.thumbnailUrl || '',
    orientation: clip.orientation || 'landscape',
    game: clip.game || '',
    views: clip.views || 0,
  };
}

function previewLayers(compCreative, leadClip) {
  const layout = compCreative?.layout || {};
  const hooks = compCreative?.hooks || {};
  const captions = compCreative?.captions || {};
  const mode = layout.mode || 'blur_pad';
  const logoCorner = layout.logoCorner || (layout.logo === 'top_blur_fold' ? 'top_blur_fold' : 'bottom_right');
  return {
    aspect: '9:16',
    layoutMode: mode,
    logoCorner,
    hookZone: hooks.rankedList?.enabled ? 'top_ranked' : (mode === 'full_bleed_crop' ? 'upper_mid' : 'top_center'),
    captionZone: captions.whisper ? (mode === 'blur_pad' ? 'bottom_blur_fold' : 'bottom_safe') : 'off',
    hookMode: hooks.mode || 'both',
    rankedList: !!hooks.rankedList?.enabled,
    leadThumbnail: leadClip?.thumbnailUrl || null,
    leadTitle: leadClip?.title || '',
  };
}

function featureManifest(compCreative) {
  const chips = compCreativeChips(compCreative) || [];
  return {
    chips,
    summary: formatCompCreativeSummary(compCreative?.preset || preset),
    presetLabel: PRESET_LABELS[compCreative?.preset] || compCreative?.preset,
  };
}

function buildCompositionSpec(body = {}) {
  const clipsIn = Array.isArray(body.clips) ? body.clips : [];
  const deliveryFormat = body.deliveryFormat || body.delivery?.format || 'short';
  const preset = body.compCreativePreset || 'classic_blur_pad';
  const merged = mergeCompCreative({
    preset,
    overrides: body.compCreative || {},
    streamerHint: (clipsIn[0] && (clipsIn[0].displayName || clipsIn[0].streamer)) || body.streamerHint || null,
  });
  const clips = clipsIn.map(normalizeClip).sort((a, b) => a.order - b.order);
  const spec = {
    version: SPEC_VERSION,
    deliveryFormat,
    contentType: resolveContentType(deliveryFormat, merged),
    platforms: body.platforms || ['youtube', 'tiktok', 'instagram'],
    compCreativePreset: preset,
    compCreative: merged,
    clips,
    features: featureManifest(merged),
    preview: previewLayers(merged, clips[0]),
    totalDurationSec: clips.reduce((n, c) => n + clipDurationAfterTrim(c), 0),
  };
  const validation = validateCompositionSpec(spec);
  return { spec, validation };
}

function resolveContentType(deliveryFormat, compCreative) {
  const fmt = compCreative?.delivery?.format || deliveryFormat;
  if (fmt === 'vod_comp') return 'twitch-vod-comp';
  return 'twitch-short';
}

function validateCompositionSpec(spec) {
  const errors = [];
  const warnings = [];
  if (!spec.clips?.length) errors.push('At least one clip required');
  const preset = spec.compCreativePreset || spec.compCreative?.preset || 'classic_blur_pad';
  const target = getCompLineupTarget(preset);
  const count = spec.clips?.length || 0;
  const delivery = spec.deliveryFormat || 'short';

  if (delivery === 'short' && count >= 1) {
    /* one job per clip — warnings only */
  } else if (delivery === 'short' && count === 0) {
    errors.push('At least one clip required');
  }
  if (delivery === 'comp') {
    if (count < target.minClips) errors.push(`Comp needs at least ${target.minClips} clips (${count} provided)`);
    if (count > target.maxClips) warnings.push(`Comp uses first ${target.lineupSlots} of ${count} clips`);
    if (target.minDurationSec && spec.totalDurationSec < target.minDurationSec) {
      errors.push(`Lineup too short: ${spec.totalDurationSec}s (need ${target.minDurationSec}s+)`);
    }
  }
  if (delivery === 'vod_comp') {
    if (count < target.minClips) errors.push(`VOD comp needs at least ${target.minClips} clips`);
    if (target.minDurationSec && spec.totalDurationSec < target.minDurationSec) {
      errors.push(`VOD footage ${spec.totalDurationSec}s — need ${Math.round(target.minDurationSec / 60)}+ min`);
    }
  }
  for (const c of spec.clips || []) {
    if (!c.url && !c.pageUrl) errors.push(`Clip "${(c.title || c.id).slice(0, 40)}" missing URL`);
    if (c.trimEnd <= c.trimStart) errors.push(`Invalid trim on "${(c.title || c.id).slice(0, 30)}"`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

function toGenerateClipCompBody(spec) {
  const validation = validateCompositionSpec(spec);
  if (!validation.ok) {
    const err = new Error(validation.errors.join('; '));
    err.validation = validation;
    throw err;
  }
  const delivery = spec.deliveryFormat || 'short';
  const target = getCompLineupTarget(spec.compCreativePreset);
  let clips = spec.clips.slice();
  if (delivery === 'comp' || delivery === 'vod_comp') {
    clips = clips.slice(0, target.lineupSlots);
  }
  return {
    clips: clips.map((c) => ({
      url: c.url,
      pageUrl: c.pageUrl,
      title: c.title,
      streamer: c.streamer,
      displayName: c.displayName,
      orientation: c.orientation || 'landscape',
      duration: c.durationHint,
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
      thumbnailUrl: c.thumbnailUrl,
      game: c.game,
      views: c.views,
    })),
    contentType: spec.contentType,
    platforms: spec.platforms,
    compCreativePreset: spec.compCreativePreset,
    compCreative: spec.compCreativePreset === spec.compCreative?.preset ? undefined : stripPresetFromOverrides(spec.compCreative),
    compositionSpec: spec,
  };
}

function stripPresetFromOverrides(merged) {
  if (!merged) return undefined;
  const { preset, presetVersion, ...rest } = merged;
  return rest;
}

module.exports = {
  SPEC_VERSION,
  buildCompositionSpec,
  validateCompositionSpec,
  toGenerateClipCompBody,
  clipDurationAfterTrim,
  normalizeClip,
  previewLayers,
  featureManifest,
};
