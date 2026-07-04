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
    mp4Url: clip.mp4Url || clip.r2Url || clip.stagedUrl || '',
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
    hookZone: hooks.rankedList?.enabled ? 'top_ranked' : (mode === 'full_bleed_crop' ? 'upper_mid' : mode === 'split_screen' ? 'pane_seam' : 'top_center'),
    captionZone: captions.whisper ? (mode === 'blur_pad' ? 'bottom_blur_fold' : 'bottom_safe') : 'off',
    hookMode: hooks.mode || 'both',
    rankedList: !!hooks.rankedList?.enabled,
    leadThumbnail: leadClip?.thumbnailUrl || null,
    leadTitle: leadClip?.title || '',
  };
}

function featureManifest(compCreative) {
  const preset = compCreative?.preset || 'classic_blur_pad';
  const chips = compCreativeChips(compCreative) || [];
  return {
    chips,
    summary: formatCompCreativeSummary(preset),
    presetLabel: PRESET_LABELS[preset] || preset,
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
  const vodSegment = normalizeVodSegment(body.vodSegment);
  let resolvedClips = clips;
  if (deliveryFormat === 'vod_segment' && vodSegment) {
    resolvedClips = [vodSegmentToClip(vodSegment)];
  }
  const spec = {
    version: SPEC_VERSION,
    deliveryFormat,
    contentType: resolveContentType(deliveryFormat, merged, body.contentSource),
    platforms: body.platforms || ['youtube', 'tiktok', 'instagram'],
    compCreativePreset: preset,
    compCreative: merged,
    clips: resolvedClips,
    vodSegment,
    features: featureManifest(merged),
    preview: previewLayers(merged, resolvedClips[0]),
    totalDurationSec: resolvedClips.reduce((n, c) => n + clipDurationAfterTrim(c), 0),
  };
  const validation = validateCompositionSpec(spec);
  return { spec, validation };
}

function resolveContentType(deliveryFormat, compCreative, contentSource) {
  const src = String(contentSource || 'twitch').toLowerCase();
  const isNews = src === 'reddit' || src === 'wire' || src === 'news';
  const fmt = compCreative?.delivery?.format || deliveryFormat;
  if (fmt === 'vod_comp') return isNews ? 'news-vod-comp' : 'twitch-vod-comp';
  if (deliveryFormat === 'vod_segment') return isNews ? 'news-short' : 'twitch-short';
  return isNews ? 'news-short' : 'twitch-short';
}

function normalizeVodSegment(raw) {
  if (!raw || !raw.vodUrl) return null;
  const start = Math.max(0, Number(raw.start_sec) || 0);
  const end = raw.end_sec != null ? Number(raw.end_sec) : start + 420;
  return {
    vodUrl: raw.vodUrl,
    vodId: raw.vodId || null,
    sessionId: raw.sessionId || null,
    title: raw.title || '',
    streamer: raw.streamer || '',
    duration_sec: Number(raw.duration_sec) || end,
    start_sec: start,
    end_sec: Math.max(start + 1, end),
    summary: raw.summary || '',
  };
}

function vodSegmentToClip(vodSegment) {
  if (!vodSegment) return null;
  return {
    id: 'vod-segment',
    url: vodSegment.vodUrl,
    pageUrl: vodSegment.vodUrl,
    title: vodSegment.title || 'VOD highlight',
    streamer: vodSegment.streamer,
    displayName: vodSegment.streamer,
    order: 0,
    durationHint: vodSegment.duration_sec,
    trimStart: vodSegment.start_sec,
    trimEnd: vodSegment.end_sec,
    orientation: 'landscape',
  };
}

function validateCompositionSpec(spec) {
  const errors = [];
  const warnings = [];
  const delivery = spec.deliveryFormat || 'short';
  const hasVodSegment = delivery === 'vod_segment' && spec.vodSegment?.vodUrl;
  if (!spec.clips?.length && !hasVodSegment) errors.push('At least one clip required');
  const preset = spec.compCreativePreset || spec.compCreative?.preset || 'classic_blur_pad';
  const target = getCompLineupTarget(preset);
  const count = spec.clips?.length || 0;

  if (delivery === 'short' && count >= 1) {
    /* one job per clip — warnings only */
  } else if (delivery === 'short' && count === 0 && !hasVodSegment) {
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
  if (delivery === 'vod_segment') {
    if (!spec.vodSegment?.vodUrl) errors.push('VOD segment requires vodSegment.vodUrl');
    else if (spec.vodSegment.end_sec <= spec.vodSegment.start_sec) {
      errors.push('VOD segment end must be after start');
    }
  }
  for (const c of spec.clips || []) {
    if (!c.url && !c.pageUrl) errors.push(`Clip "${(c.title || c.id).slice(0, 40)}" missing URL`);
    if (c.trimEnd <= c.trimStart) errors.push(`Invalid trim on "${(c.title || c.id).slice(0, 30)}"`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

function mapClipForDispatch(c) {
  return {
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
    mp4Url: c.mp4Url || undefined,
  };
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
  if (delivery === 'vod_segment' && spec.vodSegment) {
    clips = [vodSegmentToClip(spec.vodSegment)];
  } else if (delivery === 'comp' || delivery === 'vod_comp') {
    clips = clips.slice(0, target.lineupSlots);
  }
  const mapped = clips.map(mapClipForDispatch);
  const creativeOverride = spec.compCreativePreset === spec.compCreative?.preset
    ? stripPresetFromOverrides(spec.compCreative)
    : spec.compCreative;
  return {
    clips: mapped,
    contentType: spec.contentType,
    platforms: spec.platforms,
    compCreativePreset: spec.compCreativePreset,
    compCreative: creativeOverride,
    compositionSpec: spec,
  };
}

/** Short delivery with N clips → N independent dispatch bodies (one job each). */
function toGenerateClipCompJobs(spec) {
  const body = toGenerateClipCompBody(spec);
  if (spec.deliveryFormat !== 'short' || body.clips.length <= 1) {
    return [body];
  }
  return body.clips.map((c, i) => ({
    ...body,
    clips: [c],
    compositionSpec: {
      ...spec,
      clips: [spec.clips[i]].filter(Boolean),
      totalDurationSec: clipDurationAfterTrim(spec.clips[i]),
    },
  }));
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
  toGenerateClipCompJobs,
  mapClipForDispatch,
  clipDurationAfterTrim,
  normalizeClip,
  previewLayers,
  featureManifest,
  normalizeVodSegment,
  vodSegmentToClip,
};
