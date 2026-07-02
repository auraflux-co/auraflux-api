'use strict';

/**
 * Rebuild generate-full-script items[] from a job card's saved clip lineup.
 * Uses orderedClipUrls (authoritative order from the original Avatar VOD run).
 */
function buildItemsFromJobClipLineup(job) {
  if (!job || typeof job !== 'object') return [];
  const urls = job.orderedClipUrls
    || (job.meta && job.meta.orderedClipUrls)
    || [];
  if (!Array.isArray(urls) || !urls.length) return [];

  const byStreamer = new Map();
  for (const clip of urls) {
    if (!clip || typeof clip !== 'object') continue;
    const displayName = clip.displayName || clip.streamer || 'Unknown';
    const key = String(displayName).toLowerCase().replace(/\s+/g, '');
    if (!byStreamer.has(key)) {
      byStreamer.set(key, { displayName, streamer: displayName, clips: [] });
    }
    const bucket = byStreamer.get(key);
    const pageUrl = clip.pageUrl || clip.url || '';
    bucket.clips.push({
      rank: bucket.clips.length + 1,
      isBackup: !!clip.isBackup,
      title: clip.title || '',
      url: pageUrl,
      game: clip.game || '',
      thumbnailUrl: clip.thumbnailUrl || '',
      views: clip.views || 0,
      mp4Url: clip.mp4Url || '',
    });
  }

  return [...byStreamer.values()].map((entry) => {
    const first = entry.clips[0] || {};
    return {
      streamer: entry.displayName,
      displayName: entry.displayName,
      clipsPerStreamer: entry.clips.length,
      targetClipsPerStreamer: entry.clips.length,
      clips: entry.clips,
      title: first.title || '',
      url: first.url || '',
      game: first.game || '',
      thumbnailUrl: first.thumbnailUrl || '',
    };
  });
}

module.exports = { buildItemsFromJobClipLineup };
