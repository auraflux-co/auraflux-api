'use strict';
/**
 * lib/services/repurpose.js — CPD-998: one production run feeds every platform.
 *
 * When a longform job publishes (Gate 5 success), auto-spawn a vertical
 * sibling so Shorts/TikTok/IG get a cut without a second dashboard run:
 *   - twitch (incl. top10 variant) → best clip becomes an avatar-free clip
 *     short via POST /generate-clip-comp (CPD-981 pattern)
 *   - news / nba → first item re-enters POST /generate-full-script as
 *     news-short / nba-short
 *
 * Gated by REPURPOSE_SHORTS=on (default off until output quality is verified).
 * Loop guard: short-form and clips-only cards are never repurposed, so a
 * spawned sibling can never spawn its own sibling.
 */

const axios = require('axios');

function isEnabled() {
  return String(process.env.REPURPOSE_SHORTS || '').trim().toLowerCase() === 'on';
}

function shortPlatforms(contentType) {
  try {
    const { getPublishConfig } = require('../configLoader');
    const platforms = getPublishConfig(contentType)?.platforms;
    if (Array.isArray(platforms) && platforms.length) return platforms;
  } catch (_) { /* unknown type — fall through */ }
  return ['tiktok'];
}

/**
 * Decide what (if anything) to spawn for a published card.
 * Pure — no IO. Returns null (skip) or { kind, path, body, label }.
 */
function pickRepurposeAction(card) {
  if (!card) return null;
  const contentType = String(card.contentType || '');
  // Loop guard + scope: only longform avatar shows are repurposed
  if (contentType.includes('-short') || card.clipsOnly) return null;
  if (card.repurposedFrom) return null;

  const base = contentType.replace(/-short$/, '');
  const jobId = card.jobId || card.id || null;

  if (base === 'twitch') {
    const clips = Array.isArray(card.orderedClipUrls) ? card.orderedClipUrls.filter((c) => c && c.url) : [];
    if (!clips.length) return null;
    // Best clip = first in script order (top10 countdown puts #1 last — take that instead)
    const pick = card.scriptVariant === 'top10' ? clips[clips.length - 1] : clips[0];
    return {
      kind: 'clip-short',
      path: '/generate-clip-comp',
      label: `clip short (${pick.displayName || pick.streamer || 'twitch'})`,
      body: {
        clips: [{
          url: pick.url,
          pageUrl: pick.pageUrl || '',
          streamer: pick.streamer || '',
          displayName: pick.displayName || pick.streamer || '',
          title: pick.title || '',
          orientation: pick.orientation || 'landscape',
        }],
        contentType: 'twitch-short',
        platforms: shortPlatforms('twitch-short'),
        title: `Clip Short — ${pick.displayName || pick.streamer || 'Twitch'}`,
        repurposedFrom: jobId,
      },
    };
  }

  if (base === 'news' || base === 'nba') {
    const items = base === 'news' ? card.newsItems : card.nbaItems;
    if (!Array.isArray(items) || !items.length) return null;
    const shortType = `${base}-short`;
    return {
      kind: 'full-script-short',
      path: '/generate-full-script',
      label: shortType,
      body: {
        type: shortType,
        formType: 'short',
        items: [items[0]],
        platforms: shortPlatforms(shortType),
        repurposedFrom: jobId,
      },
    };
  }

  return null;
}

/** Fire the repurpose request for a just-published card. Non-fatal on any error. */
async function repurposeOnPublish(card, { baseUrl }) {
  if (!isEnabled()) return null;
  const action = pickRepurposeAction(card);
  if (!action) return null;
  const jobId = card.jobId || card.id || '?';
  try {
    const res = await axios.post(`${baseUrl}${action.path}`, action.body, { timeout: 600000 });
    console.log(`[repurpose] ${jobId}: spawned ${action.label} sibling (${action.path})`);
    return res.data;
  } catch (e) {
    console.warn(`[repurpose] ${jobId}: sibling spawn failed (non-fatal): ${e.response?.data?.error || e.message}`);
    return null;
  }
}

module.exports = { isEnabled, pickRepurposeAction, repurposeOnPublish };
