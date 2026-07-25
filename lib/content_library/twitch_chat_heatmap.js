'use strict';

/**
 * CPD-1275 — Twitch VOD "heatmap" via chat message rate (no native Most Replayed).
 * Samples GQL VideoCommentsByOffsetOrCursor across the VOD, bins offsets, finds peaks.
 */

const axios = require('axios');
const { heatmapToSegments } = require('./youtube_heatmap');

const PUBLIC_GQL_CLIENT_ID = process.env.TWITCH_GQL_CLIENT_ID
  || process.env.TWITCH_CLIENT_ID
  || 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// Persisted query hash used by Twitch web player (may rotate; failure → caller falls back).
const VIDEO_COMMENTS_HASH = process.env.TWITCH_GQL_VIDEO_COMMENTS_HASH
  || 'b70a3591ff0f4e29111727c64b9bbef84102805bfd565eb88f1567797f6b9e3e';

function extractTwitchVodId(vodUrl) {
  const m = String(vodUrl || '').match(/twitch\.tv\/videos\/(\d+)/i)
    || String(vodUrl || '').match(/\/videos\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchChatPage(videoId, contentOffsetSeconds) {
  const body = [{
    operationName: 'VideoCommentsByOffsetOrCursor',
    variables: {
      videoID: String(videoId),
      contentOffsetSeconds: Math.max(0, Math.floor(contentOffsetSeconds)),
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: VIDEO_COMMENTS_HASH,
      },
    },
  }];
  const resp = await axios.post('https://gql.twitch.tv/gql', body, {
    headers: {
      'Client-ID': PUBLIC_GQL_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (resp.status !== 200) {
    throw new Error(`Twitch GQL chat HTTP ${resp.status}`);
  }
  const payload = Array.isArray(resp.data) ? resp.data[0] : resp.data;
  if (payload?.errors?.length) {
    throw new Error(payload.errors[0].message || 'Twitch GQL chat error');
  }
  const edges = payload?.data?.video?.comments?.edges || [];
  return edges.map((e) => ({
    offset: Number(e?.node?.contentOffsetSeconds),
    text: e?.node?.message?.fragments?.map((f) => f.text).join('') || '',
  })).filter((m) => Number.isFinite(m.offset));
}

/**
 * Sample chat density across the VOD.
 * @returns {{ ok: boolean, heatmap?: Array<{start_time:number,end_time:number,value:number}>, reason?: string, message?: string }}
 */
async function fetchTwitchChatHeatmap(vodUrl, {
  durationSec = 3600,
  binSec = 20,
  maxSamples = 48,
  log = console.log,
} = {}) {
  const videoId = extractTwitchVodId(vodUrl);
  if (!videoId) {
    return { ok: false, reason: 'bad_url', message: 'Not a Twitch VOD URL' };
  }
  const dur = Math.max(120, Number(durationSec) || 3600);
  const step = Math.max(binSec, Math.floor(dur / maxSamples));
  const counts = new Map();

  try {
    for (let t = 0; t < dur; t += step) {
      const msgs = await fetchChatPage(videoId, t);
      for (const m of msgs) {
        const bin = Math.floor(m.offset / binSec) * binSec;
        counts.set(bin, (counts.get(bin) || 0) + 1);
      }
      // Be polite to GQL
      await new Promise((r) => setTimeout(r, 120));
    }
  } catch (err) {
    log(`[twitch-chat-heatmap] ${videoId}: ${err.message}`);
    return { ok: false, reason: 'gql_failed', message: err.message, videoId };
  }

  if (!counts.size) {
    return { ok: false, reason: 'no_chat', message: 'No chat samples', videoId };
  }

  const max = Math.max(...counts.values(), 1);
  const heatmap = [];
  for (let t = 0; t < dur; t += binSec) {
    const c = counts.get(t) || 0;
    heatmap.push({
      start_time: t,
      end_time: Math.min(dur, t + binSec),
      value: c / max,
    });
  }
  return {
    ok: true,
    heatmap,
    videoId,
    pointCount: heatmap.length,
    messageCount: [...counts.values()].reduce((a, b) => a + b, 0),
    binSec,
  };
}

function chatHeatmapToSegments(heatmap, opts = {}) {
  return heatmapToSegments(heatmap, {
    clipSec: opts.clipSec || 45,
    maxPeaks: opts.maxPeaks || 8,
    durationSec: opts.durationSec,
    minGapSec: opts.minGapSec || 90,
  }).map((s) => ({
    ...s,
    title: s.title || 'Chat peak',
    summary: s.summary || 'High chat velocity window',
  }));
}

module.exports = {
  extractTwitchVodId,
  fetchTwitchChatHeatmap,
  chatHeatmapToSegments,
  VIDEO_COMMENTS_HASH,
};
