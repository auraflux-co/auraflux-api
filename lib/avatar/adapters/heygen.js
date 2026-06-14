'use strict';
/**
 * HeyGen avatar adapter (CPD-989).
 *
 * Implements the lib/avatar core contract against HeyGen's v3 API.
 * Owns ALL HeyGen-specific concerns: API endpoints, auth header, request
 * body shape, avatar/voice/speed config resolution, engine selection
 * (avatar_v vs avatar_iv), and the eleven_v3 delivery-tag voice settings.
 *
 * Pipeline concerns (scene parsing, sim mode, delivery enhancement, titles,
 * polling cadence, segmentData) stay OUT of this file — they live with the
 * callers and the lib/avatar core.
 */

const axios = require('axios');

const BASE_URL = 'https://api.heygen.com';

function apiKey() {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new Error('HEYGEN_API_KEY not set in environment');
  return key;
}

/**
 * Resolve avatar/voice/speed/engine for a content type + format.
 * Moved verbatim from script_gen's sendScriptToHeyGen config block —
 * content-type config first, env-var fallbacks second.
 *
 * @param {Object} params
 * @param {string} params.contentType e.g. 'twitch', 'news-short'
 * @param {string} params.format 'landscape' | 'portrait'
 * @returns {{ avatarId, voiceId, speakSpeed, engine }}
 */
function resolveConfig({ contentType = 'twitch', format = 'landscape' } = {}) {
  const { getHeyGenConfig, getContentTypeConfig } = require('../../configLoader');

  let clipsOnly = false;
  try {
    clipsOnly = !!getContentTypeConfig(contentType).clipsOnly;
  } catch (_) {}

  if (clipsOnly) {
    return {
      avatarId: null,
      voiceId: process.env.HEYGEN_VOICE_ID,
      speakSpeed: parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85'),
      engine: process.env.HEYGEN_ENGINE || 'avatar_v'
    };
  }

  const cfg = (() => {
    try {
      const resolved = getHeyGenConfig(contentType);
      if (resolved) return resolved;
    } catch (e) {
      /* fall through to env defaults */
    }
    return {
      avatarId: format === 'portrait'
        ? process.env.HEYGEN_AVATAR_SHORT_ID
        : process.env.HEYGEN_AVATAR_ID,
      speakSpeed: parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85')
    };
  })();

  const shortAvatarFallbackByType = (() => {
    const ct = String(contentType || '').toLowerCase();
    // News shorts are always clips-only — never fall back to a HeyGen avatar ID.
    if (ct.includes('news-short')) return null;
    if (ct.includes('nba-short')) return process.env.HEYGEN_AVATAR_SHORT_NBA_ID || null;
    if (ct.includes('twitch-short') || ct.includes('clips-short')) return process.env.HEYGEN_AVATAR_SHORT_TWITCH_ID || null;
    return null;
  })();

  const avatarId = cfg.avatarId || (format === 'portrait'
    ? (shortAvatarFallbackByType || process.env.HEYGEN_AVATAR_SHORT_ID)
    : process.env.HEYGEN_AVATAR_ID);

  return {
    avatarId,
    voiceId: process.env.HEYGEN_VOICE_ID,
    speakSpeed: cfg.speakSpeed || parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85'),
    // avatar_v = cross-reference animation (better motion + lip-sync than IV).
    // All C0 looks support avatar_v (verified 2026-06-09).
    engine: process.env.HEYGEN_ENGINE || 'avatar_v'
  };
}

/**
 * Submit one avatar segment for rendering.
 *
 * @param {Object} params
 * @param {string} params.text          scene text (HeyGen `script` field, <break> tags ok)
 * @param {string} params.title         library title (UX only — matching is via videoId)
 * @param {string} params.aspectRatio   '16:9' | '9:16'
 * @param {Object} params.config        from resolveConfig() — { avatarId, voiceId, speakSpeed, engine }
 * @param {boolean} params.enhancedDelivery  true when text carries [bracket] audio tags →
 *                                      voice engine switches to eleven_v3 which interprets
 *                                      them as delivery direction instead of speaking them
 * @returns {Promise<{ videoId: string, status: string }>}
 */
async function submitSegment({ text, title, aspectRatio = '16:9', config, enhancedDelivery = false }) {
  // resolution MUST be 1080p: the 1920x1080 chrome overlay is composited onto the
  // raw render before upscale — 720p renders crop the sidebar off (CPD-879).
  const body = {
    type: 'avatar',
    avatar_id: config.avatarId,
    ...(title ? { title } : {}),
    script: text,
    voice_id: config.voiceId,
    voice_settings: {
      speed: config.speakSpeed,
      ...(enhancedDelivery ? { engine_settings: { engine_type: 'elevenlabs', model: 'eleven_v3' } } : {})
    },
    resolution: '1080p',
    aspect_ratio: aspectRatio,
    engine: { type: config.engine }
  };

  const resp = await axios.post(`${BASE_URL}/v3/videos`, body, {
    headers: { 'X-Api-Key': apiKey(), 'Content-Type': 'application/json' },
    timeout: 30000
  });

  const { video_id, status } = resp.data?.data || {};
  if (!video_id) {
    throw new Error(`HeyGen API did not return video_id: ${JSON.stringify(resp.data)}`);
  }
  return { videoId: video_id, status };
}

/**
 * Check render status of one segment.
 *
 * @param {string} videoId
 * @returns {Promise<{ status: string, videoUrl: string|null, failureMessage: string|null }>}
 *   status: 'completed' | 'processing' | 'pending' | 'failed' | ...
 */
async function getSegmentStatus(videoId) {
  const resp = await axios.get(`${BASE_URL}/v3/videos/${videoId}`, {
    headers: { 'X-Api-Key': apiKey() },
    timeout: 10000
  });
  const data = resp.data?.data || {};
  return {
    status: data.status,
    videoUrl: data.video_url || null,
    failureMessage: data.failure_message || data.error || null
  };
}

module.exports = { name: 'heygen', resolveConfig, submitSegment, getSegmentStatus };
