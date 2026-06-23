'use strict';

const axios = require('axios');
const { secToHms } = require('./time_ranges');
const { hasAnalyticsScope } = require('../services/channel_analytics');
const { getAccessToken, getChannelInfo, loadTokens, isConnected } = require('../services/youtube_direct');

const YT_ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';

function retentionEnabled() {
  return String(process.env.POST_LIVE_YT_RETENTION ?? 'on').toLowerCase() !== 'off';
}

function analyticsStartDate(session) {
  const pub = String(session?.published || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(pub)) return pub;
  const d = new Date();
  d.setDate(d.getDate() - 28);
  return d.toISOString().slice(0, 10);
}

async function fetchVideoAudienceRetention(videoId, session = {}) {
  if (!retentionEnabled()) {
    return { ok: false, reason: 'disabled', message: 'POST_LIVE_YT_RETENTION=off' };
  }
  if (!videoId) return { ok: false, reason: 'no_video_id' };
  if (!isConnected()) {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'Connect YouTube OAuth at /connect/youtube',
      connectUrl: '/connect/youtube',
    };
  }
  const tokens = loadTokens();
  if (!hasAnalyticsScope(tokens)) {
    return {
      ok: false,
      reason: 'no_analytics_scope',
      message: 'Reconnect /connect/youtube with yt-analytics.readonly scope',
      connectUrl: '/connect/youtube',
    };
  }

  const accessToken = await getAccessToken();
  const channel = await getChannelInfo(accessToken);
  if (!channel?.channelId) {
    return { ok: false, reason: 'no_channel', message: 'Could not resolve YouTube channel id' };
  }

  const startDate = analyticsStartDate(session);
  const endDate = new Date().toISOString().slice(0, 10);

  try {
    const res = await axios.get(YT_ANALYTICS, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        ids: `channel==${channel.channelId}`,
        startDate,
        endDate,
        metrics: 'audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching',
        dimensions: 'elapsedVideoTimeRatio',
        filters: `video==${videoId}`,
        sort: 'elapsedVideoTimeRatio',
      },
      timeout: 30_000,
    });

    const headers = res.data?.columnHeaders || [];
    const nameIdx = Object.fromEntries(headers.map((h, i) => [h.name, i]));
    const rows = (res.data?.rows || []).map((row) => ({
      elapsedVideoTimeRatio: Number(row[nameIdx.elapsedVideoTimeRatio]),
      audienceWatchRatio: row[nameIdx.audienceWatchRatio] != null
        ? Number(row[nameIdx.audienceWatchRatio]) : null,
      relativeRetentionPerformance: row[nameIdx.relativeRetentionPerformance] != null
        ? Number(row[nameIdx.relativeRetentionPerformance]) : null,
      startedWatching: row[nameIdx.startedWatching] != null
        ? Number(row[nameIdx.startedWatching]) : null,
      stoppedWatching: row[nameIdx.stoppedWatching] != null
        ? Number(row[nameIdx.stoppedWatching]) : null,
    })).filter((r) => Number.isFinite(r.elapsedVideoTimeRatio));

    if (!rows.length) {
      return {
        ok: false,
        reason: 'no_data',
        message: 'No retention data — video may not belong to connected channel or is too new',
      };
    }

    return {
      ok: true,
      videoId,
      channelId: channel.channelId,
      startDate,
      endDate,
      pointCount: rows.length,
      curve: rows,
    };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    return { ok: false, reason: 'api_error', message: msg.slice(0, 200) };
  }
}

/**
 * Find local maxima on the retention curve → absolute VOD timestamps.
 */
function findRetentionPeaks(curve, durationSec, opts = {}) {
  const maxPeaks = opts.maxPeaks || Number(process.env.POST_LIVE_RETENTION_PEAKS) || 10;
  const minGapSec = opts.minGapSec || 45;
  if (!Array.isArray(curve) || !curve.length || !durationSec) return [];

  const points = curve.map((row) => {
    const ratio = row.elapsedVideoTimeRatio;
    const watch = row.audienceWatchRatio ?? 0;
    const rel = row.relativeRetentionPerformance ?? 0;
    const startSignal = row.startedWatching ?? 0;
    const score = watch * 0.55 + Math.max(0, rel) * 0.25 + Math.min(startSignal / 1000, 1) * 0.2;
    return {
      start_s: Math.floor(ratio * durationSec),
      elapsedVideoTimeRatio: ratio,
      audienceWatchRatio: row.audienceWatchRatio,
      relativeRetentionPerformance: row.relativeRetentionPerformance,
      startedWatching: row.startedWatching,
      score,
    };
  });

  const peaks = [];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1].score;
    const cur = points[i].score;
    const next = points[i + 1].score;
    if (cur >= prev && cur >= next && cur > 0) peaks.push(points[i]);
  }

  peaks.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const p of peaks) {
    if (picked.some((x) => Math.abs(x.start_s - p.start_s) < minGapSec)) continue;
    picked.push(p);
    if (picked.length >= maxPeaks) break;
  }

  return picked.sort((a, b) => a.start_s - b.start_s);
}

function filterPeaksForAnalyzableWindows(peaks, durationSec, skipRanges) {
  const { analyzableWindows } = require('./time_ranges');
  const windows = analyzableWindows(0, durationSec, skipRanges || []);
  return (peaks || []).filter((p) => {
    for (const ex of skipRanges || []) {
      if (p.start_s >= ex.start && p.start_s < ex.end) return false;
    }
    return windows.some((w) => p.start_s >= w.start && p.start_s <= w.end - 30);
  });
}

function formatRetentionPromptBlock(peaks) {
  if (!peaks?.length) {
    return '(No YouTube Analytics retention peaks available — connect /connect/youtube or video may be too new.)';
  }
  const lines = [
    'These are audience retention / replay spikes from YouTube Analytics (similar to Studio "most replayed"):',
  ];
  for (const p of peaks) {
    const watch = p.audienceWatchRatio != null ? `watch ${Number(p.audienceWatchRatio).toFixed(2)}` : 'watch n/a';
    const rel = p.relativeRetentionPerformance != null
      ? `rel ${Number(p.relativeRetentionPerformance).toFixed(2)}`
      : 'rel n/a';
    lines.push(`- ${secToHms(p.start_s)} | ${watch} | ${rel}`);
  }
  lines.push(
    'Use these as CANDIDATE timestamps — validate each against the VOD video samples.',
    'Reject peaks that are dead air, intro/outro, copyright gaps, or multiview lulls despite the spike.',
    'Boost score when a peak aligns with a comp-worthy reaction you see/hear in the samples.',
  );
  return lines.join('\n');
}

async function getRetentionContextForSession(session, skipRanges = []) {
  const durationSec = session?.durationSec || 7200;
  const fetched = await fetchVideoAudienceRetention(session?.videoId, session);
  if (!fetched.ok) {
    return {
      ok: false,
      peaks: [],
      promptBlock: formatRetentionPromptBlock([]),
      meta: {
        reason: fetched.reason,
        message: fetched.message,
        connectUrl: fetched.connectUrl || null,
      },
    };
  }

  const allPeaks = findRetentionPeaks(fetched.curve, durationSec);
  const peaks = filterPeaksForAnalyzableWindows(allPeaks, durationSec, skipRanges);

  return {
    ok: true,
    peaks,
    allPeakCount: allPeaks.length,
    promptBlock: formatRetentionPromptBlock(peaks),
    meta: {
      pointCount: fetched.pointCount,
      startDate: fetched.startDate,
      endDate: fetched.endDate,
      channelId: fetched.channelId,
    },
  };
}

function boostCandidatesNearRetentionPeaks(candidates, peaks, slackSec = 20) {
  if (!peaks?.length) return candidates;
  return candidates.map((c) => {
    const near = peaks.find((p) => Math.abs(p.start_s - c.start_s) <= slackSec);
    if (!near) return c;
    return {
      ...c,
      retentionAligned: true,
      retentionPeak_s: near.start_s,
      score: Math.min(1, (c.score || 0.5) + 0.1),
    };
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
}

module.exports = {
  retentionEnabled,
  fetchVideoAudienceRetention,
  findRetentionPeaks,
  filterPeaksForAnalyzableWindows,
  formatRetentionPromptBlock,
  getRetentionContextForSession,
  boostCandidatesNearRetentionPeaks,
};
