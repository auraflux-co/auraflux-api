'use strict';

const youtube = require('./adapters/youtube');
const twitch = require('./adapters/youtube');
const { detectPlatform } = require('./util');

const ADAPTERS = {
  youtube,
  twitch,
};

/**
 * Platform-agnostic moment finder contract.
 * @returns {Promise<{ok, vodUrl, moments, mode, candidateCount, version}>}
 */
async function findMoments(opts = {}) {
  const platform = detectPlatform(opts.vodUrl);
  const adapter = ADAPTERS[platform] || youtube;
  return adapter.findMoments(opts);
}

function momentsToCompositionClips(moments = [], vodUrl = '', streamer = '') {
  return moments.map((m, i) => ({
    id: m.id || `moment-${i}`,
    url: vodUrl,
    pageUrl: vodUrl,
    title: m.title || `Moment ${i + 1}`,
    streamer: streamer || 'vod',
    displayName: streamer || 'VOD',
    order: i,
    durationHint: m.duration_sec || Math.max(1, m.end_sec - m.start_sec),
    trimStart: m.start_sec,
    trimEnd: m.end_sec,
    postLiveVod: /youtube\.com|youtu\.be/.test(vodUrl),
    viralityScore: m.score,
    hook_score: m.hook_score,
    coherence_score: m.coherence_score,
    connection_score: m.connection_score,
    trend_score: m.trend_score,
    momentSummary: m.summary || '',
  }));
}

module.exports = {
  findMoments,
  momentsToCompositionClips,
};
