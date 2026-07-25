'use strict';

/**
 * CPD-1278 — Paste long-form URL → scored moment windows (YouTube heatmap / Twitch chat / Gemini).
 */

const { analyzeVodHighlights } = require('./vod_highlights');
const { isYoutubeUrl, extractYoutubeVideoId } = require('./youtube_heatmap');
const { extractTwitchVodId } = require('./twitch_chat_heatmap');

function detectPlatform(url) {
  if (isYoutubeUrl(url)) return 'youtube';
  if (/twitch\.tv\/videos\//i.test(url) || /twitch\.tv\/.*\/v\//i.test(url)) return 'twitch';
  return null;
}

async function analyzePasteUrl(input = {}, { log = console.log } = {}) {
  const url = String(input.url || input.vodUrl || '').trim();
  if (!url) throw new Error('url required');
  const platform = input.platform || detectPlatform(url);
  if (!platform) throw new Error('Only YouTube or Twitch VOD URLs supported');

  const vodId = input.vodId
    || (platform === 'youtube' ? extractYoutubeVideoId(url) : extractTwitchVodId(url));

  const out = await analyzeVodHighlights({
    platform,
    streamer: input.streamer || 'paste',
    vodUrl: url,
    vodId,
    title: input.title || 'Pasted VOD',
    durationSec: input.durationSec || input.duration_sec || 7200,
    views: input.views || 0,
    targetSec: input.targetSec != null ? Number(input.targetSec) : 45,
    maxPeaks: input.maxPeaks != null ? Number(input.maxPeaks) : 8,
    log,
  });

  return {
    ok: true,
    platform,
    vodUrl: url,
    vodId,
    ...out,
  };
}

module.exports = {
  detectPlatform,
  analyzePasteUrl,
};
