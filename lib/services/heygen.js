'use strict';
/**
 * lib/services/heygen.js — Singleton HeyGen service for AuraFlux.
 * ⚠️  C0-ONLY: HeyGen is not in the C1+ default pipeline.
 *    It is an optional add-on. Import this service only in C0 paths
 *    or behind an explicit `providers.avatar === 'heygen'` config check.
 *
 * Wraps lib/clients/heygen_client.js with:
 *   - Pre-initialized singleton (API key loaded once)
 *   - Convenience helpers matching the call patterns in assembly.js + script_gen.js
 *
 * Usage:
 *   const { callHeyGen, isConfigured } = require('./services/heygen');
 *   if (!isConfigured()) return { ok: false, error: 'HeyGen not configured' };
 *   const { video_id } = await callHeyGen.generateVideo(body);
 */

const HeyGenClient = require('../clients/heygen_client');

// ── Singleton ─────────────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (_client) return _client;
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new Error('[services/heygen] HEYGEN_API_KEY is not set');
  _client = new HeyGenClient(key);
  return _client;
}

/**
 * Returns true if HEYGEN_API_KEY is configured.
 */
function isConfigured() {
  return !!process.env.HEYGEN_API_KEY;
}

/**
 * Generate a HeyGen avatar video.
 * @param {Object} body — HeyGen /v2/video/generate request body
 * @returns {Promise<{ video_id: string }>}
 */
async function generateVideo(body) {
  return getClient().generateVideo(body);
}

/**
 * Poll video status by video_id.
 * @param {string} videoId
 * @returns {Promise<{ status: string, video_url: string|null }>}
 */
async function getVideoStatus(videoId) {
  return getClient().getVideoStatus(videoId);
}

/**
 * List recent HeyGen videos.
 * @param {number} [limit=100]
 * @returns {Promise<Array>}
 */
async function listVideos(limit = 100) {
  return getClient().listVideos(limit);
}

/**
 * Delete a HeyGen video by ID.
 * @param {string} videoId
 */
async function deleteVideo(videoId) {
  return getClient().deleteVideo(videoId);
}

module.exports = {
  getClient,
  isConfigured,
  generateVideo,
  getVideoStatus,
  listVideos,
  deleteVideo,
};
