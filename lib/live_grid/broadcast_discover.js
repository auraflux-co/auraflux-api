'use strict';

const LIVE_CYCLE_RANK = { live: 0, testing: 1, ready: 2, created: 3 };

function lifecycleRank(status) {
  return LIVE_CYCLE_RANK[status] ?? 99;
}

/** Pick the best active broadcast bound to a fixed ingest stream key. */
function pickBestForStream(broadcasts, streamId) {
  if (!streamId || !Array.isArray(broadcasts)) return null;
  const matches = broadcasts.filter(
    (b) => b.boundStreamId === streamId && b.lifeCycleStatus !== 'complete',
  );
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const lc = lifecycleRank(a.lifeCycleStatus) - lifecycleRank(b.lifeCycleStatus);
    if (lc !== 0) return lc;
    const pub = (a.privacyStatus === 'public' ? 0 : 1) - (b.privacyStatus === 'public' ? 0 : 1);
    return pub;
  });
  return matches[0].broadcastId;
}

/**
 * Map main + solo seats to YouTube broadcast IDs using bound ingest stream keys.
 * @param {object} opts
 * @param {Array} opts.broadcasts — from YouTube API (boundStreamId, lifeCycleStatus, …)
 * @param {string} [opts.mainStreamId]
 * @param {string} [opts.mainBroadcastIdFallback]
 * @param {object|Array} [opts.soloStreamIds] — seat 1–4 or quadrant 0–3 → streamId
 */
function discoverBroadcastIds(opts = {}) {
  const { broadcasts = [], mainStreamId, mainBroadcastIdFallback, soloStreamIds } = opts;
  const soloBroadcastIds = {};
  for (let q = 0; q < 4; q++) {
    const seat = q + 1;
    const sid = soloStreamIds?.[seat] ?? soloStreamIds?.[String(seat)] ?? soloStreamIds?.[q] ?? null;
    const bid = pickBestForStream(broadcasts, sid);
    if (bid) soloBroadcastIds[seat] = bid;
  }

  let mainBroadcastId = pickBestForStream(broadcasts, mainStreamId);
  if (!mainBroadcastId && mainBroadcastIdFallback) {
    const fb = broadcasts.find(
      (b) => b.broadcastId === mainBroadcastIdFallback && b.lifeCycleStatus !== 'complete',
    );
    if (fb) mainBroadcastId = fb.broadcastId;
  }

  return { mainBroadcastId: mainBroadcastId || null, soloBroadcastIds };
}

module.exports = {
  lifecycleRank,
  pickBestForStream,
  discoverBroadcastIds,
};
