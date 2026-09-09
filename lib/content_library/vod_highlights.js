'use strict';
/**
 * VOD peak analysis — YouTube Most Replayed first (customer Peaks MVP).
 * Twitch chat heatmap optional if module present; else heuristic fallback.
 */

const { upsertVodSession, saveVodSegments, getVodSegments } = require('./store');

async function analyzeVodHighlights({
  platform,
  streamer,
  vodUrl,
  vodId,
  title,
  durationSec,
  views,
  targetSec = 45,
  maxPeaks = 8,
  brandId = null,
  log = console.log,
} = {}) {
  const {
    isYoutubeUrl,
    extractYoutubeVideoId,
    fetchYoutubeHeatmap,
    heatmapToSegments,
  } = require('./youtube_heatmap');

  const resolvedPlatform = platform
    || (isYoutubeUrl(vodUrl) ? 'youtube' : 'twitch');
  const resolvedVodId = vodId
    || (resolvedPlatform === 'youtube' ? extractYoutubeVideoId(vodUrl) : null)
    || (String(vodUrl || '').match(/videos\/(\d+)/)?.[1]);

  const sessionId = await upsertVodSession({
    platform: resolvedPlatform,
    streamer: streamer || 'unknown',
    vod_id: resolvedVodId || `tmp_${Date.now()}`,
    url: vodUrl,
    title,
    duration_sec: durationSec,
    views: views || 0,
    status: 'analyzing',
    brand_id: brandId,
  });

  const clipSec = Number(targetSec) > 0 && Number(targetSec) <= 120
    ? Number(targetSec)
    : 45;

  if (resolvedPlatform === 'youtube' || isYoutubeUrl(vodUrl)) {
    try {
      const heat = await fetchYoutubeHeatmap(vodUrl);
      if (heat.ok && heat.heatmap?.length) {
        const segments = heatmapToSegments(heat.heatmap, {
          clipSec,
          maxPeaks,
          durationSec,
        });
        if (segments.length) {
          await saveVodSegments(sessionId, segments);
          log(`[vod-highlights] youtube_heatmap: ${segments.length} peak(s) from ${heat.pointCount} markers`);
          return {
            ok: true,
            sessionId,
            segments,
            mode: 'youtube_heatmap',
            heatmapMeta: {
              pointCount: heat.pointCount,
              videoId: heat.videoId || resolvedVodId,
              clipSec,
            },
          };
        }
      } else {
        log(`[vod-highlights] heatmap unavailable (${heat.reason || 'unknown'}): ${heat.message || ''}`);
      }
    } catch (heatErr) {
      log(`[vod-highlights] heatmap fetch failed: ${heatErr.message}`);
    }
  }

  try {
    const {
      fetchTwitchChatHeatmap,
      chatHeatmapToSegments,
    } = require('./twitch_chat_heatmap');
    if (resolvedPlatform === 'twitch' || /twitch\.tv\/videos\//i.test(String(vodUrl || ''))) {
      const heat = await fetchTwitchChatHeatmap(vodUrl, {
        durationSec,
        maxSamples: 40,
        log,
      });
      if (heat.ok && heat.heatmap?.length) {
        const segments = chatHeatmapToSegments(heat.heatmap, {
          clipSec,
          maxPeaks,
          durationSec,
        });
        if (segments.length) {
          await saveVodSegments(sessionId, segments);
          return {
            ok: true,
            sessionId,
            segments,
            mode: 'twitch_chat_heatmap',
            heatmapMeta: {
              pointCount: heat.pointCount,
              videoId: heat.videoId || resolvedVodId,
              clipSec,
              messageCount: heat.messageCount,
            },
          };
        }
      }
    }
  } catch (chatErr) {
    if (!/Cannot find module/.test(String(chatErr.message))) {
      log(`[vod-highlights] twitch chat heatmap skipped: ${chatErr.message}`);
    }
  }

  const fallback = buildHeuristicSegments(durationSec, clipSec);
  await saveVodSegments(sessionId, fallback);
  return { ok: true, sessionId, segments: fallback, mode: 'heuristic' };
}

function buildHeuristicSegments(durationSec, targetSec = 45) {
  const dur = Math.max(Number(durationSec) || 3600, 120);
  const start = Math.max(0, Math.floor(dur * 0.15));
  const end = Math.min(dur, start + Math.max(15, Number(targetSec) || 45));
  return [{
    start_sec: start,
    end_sec: end,
    score: 0.5,
    title: 'Suggested highlight window',
    summary: 'Heuristic fallback — Most Replayed heatmap not available yet',
  }];
}

module.exports = {
  analyzeVodHighlights,
  buildHeuristicSegments,
  getVodSegments,
};
