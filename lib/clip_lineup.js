'use strict';

/**
 * Authoritative clip counts for scaffold + Gate 1 handoff.
 * orderedClipUrls (post source resolution) beats req.items placeholders.
 */
function resolveAuthoritativeClipCount({ orderedClipUrls, items, clipsPerStreamer, streamerCount } = {}) {
  if (Array.isArray(orderedClipUrls) && orderedClipUrls.length > 0) {
    return orderedClipUrls.length;
  }
  if (Array.isArray(items) && items.length > 0) {
    const fromNested = items.reduce(
      (n, it) => n + (Array.isArray(it?.clips) ? it.clips.length : 0),
      0
    );
    if (fromNested > 0) return fromNested;
  }
  const nStreamers = streamerCount || (Array.isArray(items) ? items.length : 0);
  const cps = clipsPerStreamer || 2;
  return nStreamers > 0 ? nStreamers * cps : 0;
}

function resolveUniformClipsPerStreamer({ orderedClipUrls, items, clipsPerStreamer } = {}) {
  if (clipsPerStreamer > 0) return clipsPerStreamer;
  const streamerCount = Array.isArray(items) ? items.length : 0;
  if (streamerCount <= 0) return 2;

  if (Array.isArray(orderedClipUrls) && orderedClipUrls.length > 0) {
    const byStreamer = new Map();
    for (const clip of orderedClipUrls) {
      const key = String(clip?.displayName || clip?.streamer || 'unknown').toLowerCase();
      byStreamer.set(key, (byStreamer.get(key) || 0) + 1);
    }
    const counts = [...byStreamer.values()];
    if (counts.length && counts.every((c) => c === counts[0])) {
      return counts[0];
    }
    return Math.max(1, Math.round(orderedClipUrls.length / streamerCount));
  }

  if (items[0]?.clips?.length > 0) {
    const counts = items.map((it) => (Array.isArray(it.clips) ? it.clips.length : 0)).filter(Boolean);
    if (counts.length && counts.every((c) => c === counts[0])) return counts[0];
    if (counts.length) return counts[0];
  }

  return 2;
}

/** Dashboard POST body → clipsPerStreamer for jobSpec scaffold (UI is source of truth). */
function resolveRequestClipsPerStreamer(body, items) {
  const fromBody = parseInt(body?.clipsPerStreamer, 10);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  if (Array.isArray(items) && items.length) {
    const counts = items.map(
      (it) => it.targetClipsPerStreamer || it.clipsPerStreamer || (Array.isArray(it.clips) ? it.clips.length : 0)
    ).filter((n) => n > 0);
    if (counts.length && counts.every((c) => c === counts[0])) return counts[0];
  }
  return 2;
}

module.exports = {
  resolveAuthoritativeClipCount,
  resolveUniformClipsPerStreamer,
  resolveRequestClipsPerStreamer,
};
