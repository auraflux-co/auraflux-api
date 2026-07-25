'use strict';

const { parseTwitchDuration } = require('../pickers/streamers/vods');
const { upsertVodSession, saveVodSegments, getVodSegments } = require('./store');
const { sampleVodFrames } = require('./vod_frame_samples');

async function analyzeVodHighlights({
  platform,
  streamer,
  vodUrl,
  vodId,
  title,
  durationSec,
  views,
  targetSec = 420,
  maxPeaks = 8,
  log = console.log,
} = {}) {
  const { isYoutubeUrl, extractYoutubeVideoId, fetchYoutubeHeatmap, heatmapToSegments } = require('./youtube_heatmap');
  const resolvedPlatform = platform
    || (isYoutubeUrl(vodUrl) ? 'youtube' : 'twitch');
  const resolvedVodId = vodId
    || (resolvedPlatform === 'youtube' ? extractYoutubeVideoId(vodUrl) : null)
    || (String(vodUrl || '').match(/videos\/(\d+)/)?.[1]);

  const sessionId = upsertVodSession({
    platform: resolvedPlatform,
    streamer,
    vod_id: resolvedVodId,
    url: vodUrl,
    title,
    duration_sec: durationSec,
    views: views || 0,
    status: 'analyzing',
  });

  // CPD-1268: public Most Replayed peaks first (works on other creators' VODs)
  if (resolvedPlatform === 'youtube' || isYoutubeUrl(vodUrl)) {
    try {
      const heat = await fetchYoutubeHeatmap(vodUrl);
      if (heat.ok && heat.heatmap?.length) {
        const clipSec = Number(targetSec) > 0 && Number(targetSec) <= 120
          ? Number(targetSec)
          : 45;
        const segments = heatmapToSegments(heat.heatmap, {
          clipSec,
          maxPeaks,
          durationSec,
        });
        if (segments.length) {
          saveVodSegments(sessionId, segments);
          log(`[vod-highlights] youtube_heatmap: ${segments.length} peak window(s) from ${heat.pointCount} markers`);
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

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    const fallback = buildHeuristicSegments(durationSec, targetSec);
    saveVodSegments(sessionId, fallback);
    return { ok: true, sessionId, segments: fallback, mode: 'heuristic' };
  }

  try {
    let frames = [];
    try {
      frames = await sampleVodFrames({ vodUrl, durationSec, maxFrames: 8, log });
    } catch (frameErr) {
      log(`[vod-highlights] frame sampling skipped: ${frameErr.message}`);
    }
    const segments = await geminiSuggestSegments({
      title,
      durationSec,
      targetSec,
      vodUrl,
      frames,
      log,
    });
    saveVodSegments(sessionId, segments);
    return { ok: true, sessionId, segments, mode: frames.length ? 'gemini_multimodal' : 'gemini' };
  } catch (err) {
    log(`[vod-highlights] Gemini failed: ${err.message}`);
    const fallback = buildHeuristicSegments(durationSec, targetSec);
    saveVodSegments(sessionId, fallback);
    return { ok: true, sessionId, segments: fallback, mode: 'heuristic_fallback', error: err.message };
  }
}

function buildHeuristicSegments(durationSec, targetSec = 420) {
  const dur = Math.max(Number(durationSec) || 3600, 600);
  const start = Math.max(0, Math.floor(dur * 0.15));
  const end = Math.min(dur, start + targetSec);
  return [{
    start_sec: start,
    end_sec: end,
    score: 0.5,
    title: 'Suggested highlight window',
    summary: 'Heuristic 15% into VOD — replace with Gemini when API available',
  }];
}

async function geminiSuggestSegments({ title, durationSec, targetSec, vodUrl, frames = [], log }) {
  const axios = require('axios');
  const frameNote = frames.length
    ? `You are given ${frames.length} frame captures spread across the VOD (labeled with timestamp seconds). Use visual cues to pick the most engaging contiguous window.`
    : 'No frames available — infer from title and duration only.';
  const prompt = `You are a Twitch VOD editor. Stream title: "${title || 'Untitled'}". Total duration: ${durationSec}s.
Pick ONE contiguous highlight window of about ${targetSec}s (7 minutes) for a YouTube long-form clip.
${frameNote}
Return JSON only: {"segments":[{"start_sec":number,"end_sec":number,"score":0-1,"title":"...","summary":"..."}]}
VOD URL (context only): ${vodUrl}`;

  const parts = [{ text: prompt }];
  for (const f of frames) {
    parts.push({ text: `Frame at ${f.sec}s:` });
    parts.push({ inline_data: { mime_type: f.mimeType || 'image/jpeg', data: f.data } });
  }

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { contents: [{ parts }] },
    { timeout: 90000 },
  );
  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Gemini response');
  const parsed = JSON.parse(jsonMatch[0]);
  const segs = (parsed.segments || []).filter((s) => Number.isFinite(s.start_sec) && Number.isFinite(s.end_sec));
  if (!segs.length) throw new Error('Empty segments');
  if (log && frames.length) log(`[vod-highlights] Gemini multimodal: ${segs.length} segment(s) from ${frames.length} frames`);
  return segs;
}

module.exports = {
  analyzeVodHighlights,
  buildHeuristicSegments,
  getVodSegments,
  parseTwitchDuration,
};
