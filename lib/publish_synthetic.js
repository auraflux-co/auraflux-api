'use strict';
/**
 * Resolve whether publish payloads should self-disclose synthetic / AI-generated media.
 *
 * Upload-Post forwards is_aigc → TikTok as "Creator labeled as AI-generated".
 * We previously sent is_aigc=true on every upload, including pure Twitch clip comps.
 */

/**
 * @param {object} opts
 * @param {string} [opts.jobType]       — dashboard job.type (twitch, twitch-short, news, …)
 * @param {string} [opts.contentType]   — fallback / legacy contentType string
 * @param {boolean} [opts.isAigc]       — explicit override from caller
 * @param {boolean} [opts.heygenUsed]   — job used HeyGen avatar renders
 * @returns {{ isAigc: boolean, containsSyntheticMedia: boolean }}
 */
function resolveSyntheticMediaFlags(opts = {}) {
  if (typeof opts.isAigc === 'boolean') {
    return {
      isAigc: opts.isAigc,
      containsSyntheticMedia: opts.isAigc,
    };
  }
  if (opts.heygenUsed === true) {
    return { isAigc: true, containsSyntheticMedia: true };
  }

  const t = String(opts.jobType || opts.contentType || '').toLowerCase().trim();
  if (!t) {
    return { isAigc: false, containsSyntheticMedia: false };
  }

  // Clip-only shorts / comps — source streamer footage, no HeyGen avatar
  if (
    /-short$/.test(t) ||
    /clip.?comp|clips-comp|streamer-comp|twitch-comp/.test(t) ||
    t === 'comp'
  ) {
    return { isAigc: false, containsSyntheticMedia: false };
  }

  // Long-form VOD shows with HeyGen anchor segments
  if (/^(twitch|news|nba)(-vod|-long)?$/.test(t) || ['twitch', 'news', 'nba'].includes(t)) {
    return { isAigc: true, containsSyntheticMedia: true };
  }

  // Default: do not self-label — avoids false "Creator labeled as AI-generated" on TikTok
  return { isAigc: false, containsSyntheticMedia: false };
}

/**
 * Gate 5 / YouTube direct upload — operator config can override HeyGen auto-disclose.
 * Priority: explicit metadata → deliverySpec → contentTypes.json publish block → heygen heuristic.
 */
function resolveContainsSyntheticMediaForPublish(jobSpec = {}, metadata = {}) {
  if (typeof metadata.containsSyntheticMedia === 'boolean') {
    return metadata.containsSyntheticMedia;
  }
  if (typeof jobSpec.deliverySpec?.containsSyntheticMedia === 'boolean') {
    return jobSpec.deliverySpec.containsSyntheticMedia;
  }
  try {
    const cfg = require('../config/contentTypes.json');
    const ct = cfg.contentTypes?.[jobSpec.contentType || metadata.contentType || ''];
    if (typeof ct?.publish?.containsSyntheticMedia === 'boolean') {
      return ct.publish.containsSyntheticMedia;
    }
  } catch (_e) { /* non-fatal */ }

  const heygenUsed = !!(
    jobSpec.heygen?.videoJobs?.length
    || jobSpec.addOns?.heygen?.active
    || metadata.heygenUsed
  );
  return resolveSyntheticMediaFlags({
    jobType: jobSpec.contentType || metadata.contentType,
    heygenUsed,
    isAigc: metadata.isAigc,
  }).containsSyntheticMedia;
}

module.exports = {
  resolveSyntheticMediaFlags,
  resolveContainsSyntheticMediaForPublish,
};
