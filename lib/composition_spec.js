'use strict';

const {
  mergeCompCreative,
  compCreativeChips,
  getCompLineupTarget,
  PRESET_LABELS,
  formatCompCreativeSummary,
  finalizeCompCreativeForAssembly,
  stripPresetFromOverrides,
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
    stagedUrl: clip.stagedUrl || clip.r2Url || clip.mp4Url || '',
    r2Url: clip.r2Url || clip.stagedUrl || clip.mp4Url || '',
    orientation: clip.orientation || 'landscape',
    game: clip.game || '',
    views: clip.views || 0,
    postLiveVod: !!clip.postLiveVod,
    vodPeakWindow: !!clip.vodPeakWindow,
    vodOrigin: clip.vodOrigin && typeof clip.vodOrigin === 'object' ? clip.vodOrigin : null,
    layoutSegments: Array.isArray(clip.layoutSegments) ? clip.layoutSegments : [],
    openingLayout: clip.openingLayout && typeof clip.openingLayout === 'object' ? clip.openingLayout : null,
    // CPD-1280–1282 CapCut-parity FX (burned in portrait assembly)
    zoomPunch: clip.zoomPunch && typeof clip.zoomPunch === 'object' ? clip.zoomPunch : null,
    cameraShake: clip.cameraShake && typeof clip.cameraShake === 'object' ? clip.cameraShake : null,
    impactTint: clip.impactTint && typeof clip.impactTint === 'object' ? clip.impactTint : null,
    speedRamps: Array.isArray(clip.speedRamps) ? clip.speedRamps : (clip.speedRamps && typeof clip.speedRamps === 'object' ? clip.speedRamps : null),
    highlightSfx: clip.highlightSfx && typeof clip.highlightSfx === 'object' ? clip.highlightSfx : null,
    overlayTexts: Array.isArray(clip.overlayTexts) ? clip.overlayTexts : null,
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
  const clips = clipsIn.map((clip, index) => normalizeClip(clip, index));
  // Preserve client COMP LINEUP order — never re-sort (clip.order can be stale/wrong).
  const vodSegment = normalizeVodSegment(body.vodSegment);
  let resolvedClips = clips;
  if (deliveryFormat === 'vod_segment' && vodSegment) {
    resolvedClips = [vodSegmentToClip(vodSegment)];
  }
  const mergedCreative = finalizeCompCreativeForAssembly(merged, {
    clipOrientations: resolvedClips.map((c) => c.orientation),
    operatorLocked: false,
  });
  if (body.compCreative?.captions?.style) {
    mergedCreative.captions = { ...mergedCreative.captions, style: body.compCreative.captions.style };
  }
  const momentFinderPrefs = normalizeMomentFinderPrefs(body.momentFinderPrefs || body.copilotPrefs);
  const spec = {
    version: SPEC_VERSION,
    deliveryFormat,
    contentType: resolveContentType(deliveryFormat, mergedCreative, body.contentSource),
    platforms: body.platforms || ['youtube', 'tiktok', 'instagram'],
    compCreativePreset: preset,
    compCreative: mergedCreative,
    clips: resolvedClips,
    vodSegment,
    momentFinderPrefs,
    primaryKeyword: String(body.primaryKeyword || '').trim().slice(0, 80) || null,
    deliveryAspect: body.deliveryAspect === '1:1' ? '1:1' : '9:16',
    momentCandidatesVersion: Number(body.momentCandidatesVersion) || 0,
    features: featureManifest(mergedCreative),
    preview: previewLayers(mergedCreative, resolvedClips[0]),
    totalDurationSec: resolvedClips.reduce((n, c) => n + clipDurationAfterTrim(c), 0),
  };
  const validation = validateCompositionSpec(spec);
  return { spec, validation };
}

function normalizeMomentFinderPrefs(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = Math.max(0, Number(raw.rangeStart ?? raw.range_start) || 0);
  const end = raw.rangeEnd != null ? Number(raw.rangeEnd ?? raw.range_end) : null;
  return {
    vodUrl: raw.vodUrl || raw.vod_url || null,
    prompt: String(raw.prompt || '').slice(0, 500),
    rangeStart: start,
    rangeEnd: end,
    minDurationSec: Math.max(5, Number(raw.minDurationSec ?? raw.min_duration_sec) || 30),
    maxDurationSec: Math.min(180, Number(raw.maxDurationSec ?? raw.max_duration_sec) || 60),
    maxCandidates: Math.min(12, Math.max(1, Number(raw.maxCandidates) || 8)),
  };
}

function resolveContentType(deliveryFormat, compCreative, contentSource) {
  const src = String(contentSource || 'twitch').toLowerCase();
  const isNews = src === 'reddit' || src === 'wire' || src === 'news';
  const isSports = src === 'sports' || src === 'nba';
  const fmt = compCreative?.delivery?.format || deliveryFormat;
  if (fmt === 'vod_comp') {
    if (isNews) return 'news-vod-comp';
    if (isSports) return 'sports-vod-comp';
    return 'twitch-vod-comp';
  }
  if (deliveryFormat === 'vod_segment') {
    if (isNews) return 'news-short';
    if (isSports) return 'sports-short';
    return 'twitch-short';
  }
  if (isNews) return 'news-short';
  if (isSports) return 'sports-short';
  return 'twitch-short';
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
  const play = vodSegment.stagedUrl || vodSegment.r2Url || vodSegment.mp4Url || '';
  const windowFile = !!(play && /^https?:\/\//i.test(play));
  const start = windowFile ? 0 : (vodSegment.start_sec || 0);
  const end = windowFile
    ? Math.max(1, (Number(vodSegment.end_sec) || 0) - (Number(vodSegment.start_sec) || 0) || Number(vodSegment.duration_sec) || 45)
    : vodSegment.end_sec;
  return {
    id: 'vod-segment',
    url: windowFile ? (vodSegment.windowPageUrl || play) : vodSegment.vodUrl,
    pageUrl: windowFile ? (vodSegment.windowPageUrl || play) : vodSegment.vodUrl,
    title: vodSegment.title || 'VOD highlight',
    streamer: vodSegment.streamer,
    displayName: vodSegment.streamer,
    order: 0,
    durationHint: windowFile ? (end - start) : vodSegment.duration_sec,
    trimStart: start,
    trimEnd: end,
    orientation: 'landscape',
    mp4Url: play || undefined,
    stagedUrl: play || undefined,
    r2Url: play || undefined,
    vodOrigin: {
      vodUrl: vodSegment.vodUrl,
      start_sec: vodSegment.start_sec,
      end_sec: vodSegment.end_sec,
      vodId: vodSegment.vodId,
    },
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
    stagedUrl: c.stagedUrl || undefined,
    r2Url: c.r2Url || undefined,
    layoutSegments: Array.isArray(c.layoutSegments) ? c.layoutSegments : [],
    openingLayout: c.openingLayout || null,
    zoomPunch: c.zoomPunch || null,
    cameraShake: c.cameraShake || null,
    impactTint: c.impactTint || null,
    speedRamps: c.speedRamps || null,
    highlightSfx: c.highlightSfx || null,
    overlayTexts: c.overlayTexts || null,
    vodPeakWindow: !!c.vodPeakWindow,
    postLiveVod: !!c.postLiveVod,
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
  const creativeOverride = stripPresetFromOverrides(spec.compCreative);
  return {
    clips: mapped,
    contentType: spec.contentType,
    platforms: spec.platforms,
    compCreativePreset: spec.compCreativePreset,
    compCreative: creativeOverride,
    compositionSpec: spec,
    editorSignedOff: true,
    editorSignedOffAt: new Date().toISOString(),
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

module.exports = {
  SPEC_VERSION,
  buildCompositionSpec,
  validateCompositionSpec,
  toGenerateClipCompBody,
  toGenerateClipCompJobs,
  mapClipForDispatch,
  clipDurationAfterTrim,
  normalizeMomentFinderPrefs,
  normalizeClip,
  previewLayers,
  featureManifest,
  normalizeVodSegment,
  vodSegmentToClip,
};
