'use strict';
/**
 * Avatar rendering core (CPD-989) — HeyGen only.
 *
 * Contract the HeyGen adapter implements:
 *   resolveConfig({ contentType, format })            -> engine-specific config object
 *   submitSegment({ text, title, aspectRatio, config,
 *                   enhancedDelivery, sceneName })  -> { videoId, status }
 *   getSegmentStatus(videoId)                         -> { status, videoUrl, failureMessage }
 *     status is normalised to: 'completed' | 'failed' | anything else = still rendering
 */

const ADAPTERS = {
  heygen: () => require('./adapters/heygen'),
};

function resolveEngine(_engine = null) {
  const requested = String(_engine || process.env.AVATAR_ENGINE || 'heygen').toLowerCase();
  if (requested !== 'heygen') {
    console.warn(`[avatar] AVATAR_ENGINE=${requested} is deprecated — using heygen`);
  }
  return ADAPTERS.heygen();
}

/** Engine-specific render config for a content type + format. */
function resolveConfig(params = {}, { engine = null } = {}) {
  return resolveEngine(engine).resolveConfig(params);
}

/** Submit one avatar segment. Errors carry the engine name + API response body when present. */
async function submitSegment(params, { engine = null } = {}) {
  const { isHeyGenLiveEnabled, heygenLiveDisabledReason } = require('../heygen_runtime');
  if (!isHeyGenLiveEnabled()) {
    throw new Error(heygenLiveDisabledReason() || 'HeyGen live disabled');
  }
  const adapter = resolveEngine(engine);
  try {
    return await adapter.submitSegment(params);
  } catch (e) {
    throw normalizeError(adapter.name, 'submit', e);
  }
}

/** Poll one segment's render status. */
async function getSegmentStatus(videoId, { engine = null } = {}) {
  const adapter = resolveEngine(engine);
  try {
    return await adapter.getSegmentStatus(videoId);
  } catch (e) {
    throw normalizeError(adapter.name, 'status', e);
  }
}

/**
 * Block until a segment completes or fails.
 * @param {string} videoId
 * @param {Object} opts { engine, maxWaitMs (default 3min), pollIntervalMs (default 10s), label }
 * @returns {Promise<{ videoUrl: string }>}
 */
async function waitForSegment(videoId, opts = {}) {
  const { engine = null, maxWaitMs = 180000, pollIntervalMs = 10000, label = videoId } = opts;
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const s = await getSegmentStatus(videoId, { engine });
    if (s.status === 'completed' && s.videoUrl) return { videoUrl: s.videoUrl };
    if (s.status === 'failed') {
      throw new Error(`Avatar render failed for ${label}: ${s.failureMessage || 'unknown'}`);
    }
  }
  throw new Error(`Avatar render timed out for ${label} after ${maxWaitMs}ms`);
}

function normalizeError(engineName, phase, e) {
  const apiBody = e.response?.data ? ` - ${JSON.stringify(e.response.data)}` : '';
  const err = new Error(`[avatar:${engineName}] ${phase} failed: ${e.message}${apiBody}`);
  err.cause = e;
  err.engine = engineName;
  err.statusCode = e.response?.status || null;
  return err;
}

module.exports = { resolveEngine, resolveConfig, submitSegment, getSegmentStatus, waitForSegment };
