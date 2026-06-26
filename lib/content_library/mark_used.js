'use strict';

const { markClipsUsedForJob: markInStore } = require('./store');
const { extractClipIdFromUrl } = require('./clip_ids');

function collectClipUrlsFromCard(card) {
  const urls = new Set();
  if (!card || typeof card !== 'object') return [];
  const push = (u) => { if (u) urls.add(String(u)); };

  (card.orderedClipUrls || []).forEach((c) => {
    push(c.pageUrl || c.clipUrl || c.url);
  });
  (card.clips || []).forEach((c) => {
    push(c.pageUrl || c.clipUrl || c.url);
  });
  (card.sourceClipSegments || []).forEach((s) => {
    push(s.pageUrl || s.clipUrl);
  });
  if (card.compCreative?.sourceClips) {
    card.compCreative.sourceClips.forEach((c) => push(c.url || c.clipUrl));
  }
  return [...urls];
}

function markLibraryClipsUsedForJob(jobId, cardOrUrls) {
  const urls = Array.isArray(cardOrUrls)
    ? cardOrUrls
    : collectClipUrlsFromCard(cardOrUrls);
  const normalized = urls.flatMap((u) => {
    const id = extractClipIdFromUrl(u);
    return id ? [u, id] : [u];
  });
  return markInStore(jobId, normalized);
}

module.exports = {
  collectClipUrlsFromCard,
  markLibraryClipsUsedForJob,
};
