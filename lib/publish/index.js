'use strict';
/**
 * lib/publish/index.js — Direct platform publish core (CPD-86)
 *
 * Platform-agnostic contract. Selects the correct adapter based on platform.
 * Falls back to Upload-Post (portal5.js) if direct adapter unavailable or feature not enabled.
 *
 * Adapters: youtube, tiktok, instagram
 * Each adapter exports: publish({ videoPath, metadata, jobSpec, tokens }) → { platformJobId, url, status }
 *
 * Feature gates:
 *   publish.direct_youtube → dwy+
 *   publish.direct_tiktok  → dfy+ (also covers instagram)
 */

const path = require('path');
const { isFeatureEnabled } = require('../services/feature_gate');
const { loadTokens } = require('../services/token_store');
const { logError } = require('../error_logger');

const ADAPTERS = {
  youtube: './adapters/youtube',
  tiktok: './adapters/tiktok',
  instagram: './adapters/instagram',
};

const FEATURE_KEYS = {
  youtube: 'publish.direct_youtube',
  tiktok: 'publish.direct_tiktok',
  instagram: 'publish.direct_tiktok', // same gate as TikTok
};

/**
 * Publish a video to a single platform directly (no Upload-Post).
 *
 * @param {object} p
 * @param {string} p.platform     — 'youtube' | 'tiktok' | 'instagram'
 * @param {string} p.videoPath    — local path or HTTPS URL
 * @param {object} p.metadata     — platform-specific metadata (title, caption, etc.)
 * @param {object} p.jobSpec      — full job spec (planTier, customerId, publishCopy, etc.)
 * @returns {object} { platformJobId, url, status, platform }
 */
async function publishDirect({ platform, videoPath, metadata = {}, jobSpec }) {
  const featureKey = FEATURE_KEYS[platform];
  if (!featureKey) throw new Error(`Unknown platform: ${platform}`);

  if (!isFeatureEnabled(featureKey, jobSpec?.planTier)) {
    throw new Error(`publish.${platform} not available on plan tier: ${jobSpec?.planTier}`);
  }

  const customerId = jobSpec?.customerId;
  const brandId = jobSpec?.brandId;
  if (!customerId) throw new Error('jobSpec.customerId is required for direct publish');
  if (!brandId) throw new Error('jobSpec.brandId is required for brand-specific publish');

  const tokens = await loadTokens(customerId, brandId, platform);
  if (!tokens) {
    throw new Error(
      `No ${platform} OAuth tokens found for customer ${customerId} brand ${brandId}. ` +
        'Customer must connect their account via dashboard settings.'
    );
  }

  const adapterPath = ADAPTERS[platform];
  const adapter = require(adapterPath);

  const result = await adapter.publish({ videoPath, metadata, jobSpec, tokens });
  return { ...result, platform };
}

/**
 * Publish to all declared platforms for a job.
 * Skips platforms with no stored tokens (logs a warning instead of failing).
 * Returns an array of per-platform results.
 *
 * @param {object} p
 * @param {string}   p.videoPath
 * @param {string[]} p.platforms     — ['youtube', 'tiktok', 'instagram']
 * @param {object}   p.metadata      — metadata applied to all platforms (title, caption, etc.)
 * @param {object}   p.jobSpec
 * @returns {object[]} Array of { platform, ok, platformJobId, url, status, error }
 */
async function publishAll({ videoPath, platforms = [], metadata = {}, jobSpec }) {
  const results = [];
  for (const platform of platforms) {
    try {
      const r = await publishDirect({ platform, videoPath, metadata, jobSpec });
      results.push({ platform, ok: true, ...r });
    } catch (err) {
      logError('PUBLISH_DIRECT_FAIL', err, { platform, jobId: jobSpec?.jobId });
      results.push({ platform, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Check whether a customer has direct publish capability for a platform.
 * Returns { canDirect, reason }.
 */
async function canPublishDirect(platform, jobSpec) {
  const featureKey = FEATURE_KEYS[platform];
  if (!featureKey || !isFeatureEnabled(featureKey, jobSpec?.planTier)) {
    return { canDirect: false, reason: 'feature not enabled for plan' };
  }
  const { hasValidToken } = require('../services/token_store');
  const valid = await hasValidToken(jobSpec?.customerId, jobSpec?.brandId, platform);
  if (!valid) return { canDirect: false, reason: 'no connected account' };
  return { canDirect: true };
}

module.exports = { publishDirect, publishAll, canPublishDirect, ADAPTERS };
