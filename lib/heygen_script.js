'use strict';
/**
 * HeyGen v3 script normalization — single source of truth for dashboard + server.
 *
 * Pause methods (HeyGen v3 POST /v3/videos, verified 2026-06-27):
 * - Method 1 (short): commas, newlines, ellipses — handled by natural script text
 * - Method 2 (exact): `<break time="4s"/>` inline in `script` (SSML-style; no input_type on v3 videos)
 *   Dashboard `<pause=4.0>` aliases are normalized here → break tags
 * - Method 3 (custom audio): audio_url/audio_asset_id on create-video — not used for Talk Soup;
 *   operator crowd track is mixed in assembly during the script pause window instead
 *
 * Requires a voice with support_pause=true (custom/ElevenLabs voices — not all public voices).
 * `[studio laugh]` in Gate-1 script → `<break time="4s"/>` at HeyGen submit.
 */

const BREAK_TAG = ' <break time="1s"/> ';
const STUDIO_LAUGH_MARKER = '[studio laugh]';
const { sanitizeSpokenTextForScene } = require('./heygen_spoken_sanitize');

function studioLaughBreakTag(pauseSec = 4) {
  const sec = Number(pauseSec) || 4;
  return ` <break time="${sec.toFixed(1).replace(/\.0$/, '')}s"/> `;
}

/** Normalize dashboard / legacy pause tags to v3 break syntax. */
function normalizePauseTags(text, defaultPauseSec = 4) {
  return String(text || '')
    .replace(/<pause\s*=\s*([\d.]+)\s*\/?>/gi, (_m, sec) => studioLaughBreakTag(sec))
    .replace(/<pause\s+time\s*=\s*["']?([\d.]+)s?["']?\s*\/?>/gi, (_m, sec) => studioLaughBreakTag(sec));
}

function prepareHeyGenScript(raw, opts = {}) {
  let text = String(raw || '');
  text = sanitizeSpokenTextForScene(text, opts.sceneName || null);
  const laughBreak = studioLaughBreakTag(opts.reactionPauseSec);
  text = normalizePauseTags(text, opts.reactionPauseSec);
  text = text
    .replace(/\[studio\s+laugh\]/gi, laughBreak)
    .replace(/\[crowd\s+laugh\]/gi, laughBreak)
    .replace(/\[laugh\s+pause\]/gi, laughBreak)
    .replace(/\[beat\]/gi, BREAK_TAG)
    .replace(/\[CLIP PLAYS HERE[^\]]*\]/gi, ' ')
    .replace(/\[TRANSITION[^\]]*\]/gi, ' ')
    // Legacy dashboard bug — rewrite ms breaks before send
    .replace(/<break\s+time="\d+ms"\s*\/?>/gi, BREAK_TAG)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\.{4,}/g, '...')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text;
}

/** Pre-flight checks — returns human-readable issues (empty = ok). */
function validateHeyGenScript(script) {
  const issues = [];
  const s = String(script || '');
  if (/time="\d+ms"/i.test(s)) {
    issues.push('Break tags must use seconds (<break time="1s"/>), not milliseconds');
  }
  if (/^<speak[\s>]/i.test(s)) {
    issues.push('Do not wrap script in <speak> — v3 accepts breaks inline');
  }
  return issues;
}

/** Normalise HeyGen error JSON for logs + dashboard banners. */
function parseHeyGenApiError(data, httpStatus) {
  if (!data) return `HTTP ${httpStatus || '?'}`;
  const err = data.error || data;
  if (typeof err === 'string') return err;
  const parts = [err.message || err.code || data.message].filter(Boolean);
  if (err.param) parts.push(`param=${err.param}`);
  if (err.doc_url) parts.push(err.doc_url);
  return parts.join(' — ') || JSON.stringify(data);
}

/** Parse dashboard HeyGen title: jobId_04_LACY_CLIP1_REACTION */
function parseHeyGenJobTitle(jobId, title) {
  if (!title || !jobId) return null;
  const prefix = `${jobId}_`;
  if (!String(title).startsWith(prefix)) return null;
  const tail = String(title).slice(prefix.length);
  const m = tail.match(/^(\d{2})_(.+)$/);
  if (!m) return null;
  return { sceneIndex: parseInt(m[1], 10), sceneName: m[2] };
}

module.exports = {
  BREAK_TAG,
  STUDIO_LAUGH_MARKER,
  studioLaughBreakTag,
  prepareHeyGenScript,
  validateHeyGenScript,
  parseHeyGenApiError,
  parseHeyGenJobTitle,
};
