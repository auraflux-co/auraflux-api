'use strict';
/** Resolve publish SEO profile from source platform — preset/C10 agnostic. */

function detectUrlPlatform(url = '') {
  const u = String(url || '');
  if (/youtube\.com|youtu\.be/i.test(u)) return 'youtube';
  if (/twitch\.tv/i.test(u)) return 'twitch';
  if (/kick\.com/i.test(u)) return 'kick';
  return '';
}

function collectSourceObjects({
  clipCompBrief = null,
  items = [],
  clips = [],
  orderedClipUrls = [],
  segmentData = [],
} = {}) {
  return [
    ...(clipCompBrief?.clips || []),
    ...(items || []),
    ...(clips || []),
    ...(orderedClipUrls || []),
    ...(segmentData || []),
  ];
}

function collectSourcePlatforms(signals = {}) {
  const platforms = new Set();
  for (const obj of collectSourceObjects(signals)) {
    if (!obj || typeof obj !== 'object') continue;
    const platform = String(obj.platform || obj.sourcePlatform || '').toLowerCase();
    if (platform) platforms.add(platform);
    for (const key of ['pageUrl', 'url', 'clipUrl', 'vodUrl', 'mp4Url']) {
      const p = detectUrlPlatform(obj[key]);
      if (p) platforms.add(p);
    }
    if (obj.vodOrigin && typeof obj.vodOrigin === 'object') {
      const vp = String(obj.vodOrigin.platform || '').toLowerCase();
      if (vp) platforms.add(vp);
      const vu = detectUrlPlatform(obj.vodOrigin.url || obj.vodOrigin.vodUrl || '');
      if (vu) platforms.add(vu);
    }
    if (obj.vodPeakWindow || obj.postLiveVod) {
      const vu = detectUrlPlatform(obj.pageUrl || obj.url || '');
      if (vu) platforms.add(vu);
    }
  }

  for (const s of signals.streamers || []) {
    try {
      const { resolveStreamer } = require('./pickers/streamers/config');
      const key = typeof s === 'string' ? s : (s.login || s.streamer || s.displayName || '');
      const entry = resolveStreamer(key);
      if (entry?.platform) platforms.add(String(entry.platform).toLowerCase());
    } catch (_) { /* non-fatal */ }
  }

  return platforms;
}

/**
 * Non-Twitch source video (YouTube VOD, performance clip, etc.) — not tied to any Compose preset.
 */
function isSourceVideoSeo({ platforms, contentType = '' } = {}) {
  const hasYoutube = platforms.has('youtube');
  const hasTwitch = platforms.has('twitch');
  const ct = String(contentType || '').toLowerCase();
  if (hasYoutube && !hasTwitch) return true;
  if (ct.includes('youtube') && !ct.includes('twitch')) return true;
  if ((ct.includes('vod') || ct.includes('source-video')) && hasYoutube) return true;
  return false;
}

function resolvePublishSeoContext({
  contentType = '',
  clipCompBrief = null,
  compCreative = null,
  streamers = [],
  items = [],
  clips = [],
  orderedClipUrls = [],
  segmentData = [],
} = {}) {
  const ct = String(contentType || '').toLowerCase();
  const platforms = collectSourcePlatforms({
    clipCompBrief,
    items,
    clips,
    orderedClipUrls,
    segmentData,
    streamers,
  });

  const hasYoutube = platforms.has('youtube');
  const hasTwitch = platforms.has('twitch');
  const dualStack = !!(compCreative?.preset === 'dual_source_stack'
    || compCreative?.layout?.mode === 'dual_source_vstack'
    || clipCompBrief?.dualSourceStack);
  let sourceVideo = isSourceVideoSeo({ platforms, contentType: ct });
  // C11 Then/Now imports/YouTube stacks must not use Twitch highlight SEO tropes
  if (dualStack && (!hasTwitch || hasYoutube || clipCompBrief?.sourceVideoPreferred)) {
    sourceVideo = true;
  }

  let seoKind = 'twitch';
  if (sourceVideo) seoKind = 'source-video';
  else if (dualStack) seoKind = 'source-video';
  else if (ct.includes('sport') || ct.includes('nba')) seoKind = 'sports';
  else if (ct.includes('news')) seoKind = 'news';
  else if (!ct.includes('twitch') && !ct.includes('clip') && !ct.includes('streamer')) seoKind = 'viral';

  const observations = (clipCompBrief?.clips || [])
    .map((c) => String(c.observation || '').trim())
    .filter((o) => o.length > 40
      && !/analysis unavailable|title fallback|Repurpose segment/i.test(o));

  const subjectName = clipCompBrief?.leadStreamer
    || (typeof streamers[0] === 'string' ? streamers[0] : (streamers[0]?.displayName || streamers[0]?.streamer || ''));

  return {
    seoKind,
    /** @deprecated use seoKind === 'source-video' */
    isReactionShort: sourceVideo,
    sourceVideo,
    sourcePlatform: hasYoutube && !hasTwitch ? 'youtube' : (hasTwitch ? 'twitch' : 'unknown'),
    subjectName: String(subjectName || '').trim(),
    sourceChannel: String(clipCompBrief?.sourceChannel || '').trim(),
    hasGeminiObservations: observations.length > 0,
    geminiObservationBlock: observations.slice(0, 6).join('\n\n'),
  };
}

/** Publish contentType string from job card + clip sources (preset agnostic). */
function resolvePublishContentType({
  jobContentType = 'twitch-short',
  clipCompBrief = null,
  streamers = [],
  items = [],
  clips = [],
  orderedClipUrls = [],
  segmentData = [],
} = {}) {
  const ctx = resolvePublishSeoContext({
    contentType: jobContentType,
    clipCompBrief,
    streamers,
    items,
    clips,
    orderedClipUrls,
    segmentData,
  });
  if (ctx.sourceVideo || ctx.sourcePlatform === 'youtube' || ctx.seoKind === 'source-video') {
    return 'youtube-short';
  }
  const allowed = [
    'twitch-short', 'news-short', 'sports-short', 'youtube-short',
    'twitch-vod-comp', 'news-vod-comp', 'sports-vod-comp',
  ];
  return allowed.includes(jobContentType) ? jobContentType : 'twitch-short';
}

module.exports = {
  detectUrlPlatform,
  collectSourcePlatforms,
  resolvePublishSeoContext,
  resolvePublishContentType,
};
