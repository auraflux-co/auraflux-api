'use strict';

const { markClipsUsedForJob: markInStore } = require('./store');
const { markStagedClipsUsedForJob } = require('./staged_store');
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
  const marked = markInStore(jobId, normalized) + markStagedClipsUsedForJob(jobId, urls);
  if (marked > 0) {
    // CPD-1210 — record view prediction for the job's clips (deduped inside)
    try {
      require('../intelligence/predict').recordPredictionsForJob(jobId);
    } catch (e) {
      console.warn('[predict] view prediction record failed:', e.message);
    }
  }
  return marked;
}

module.exports = {
  collectClipUrlsFromCard,
  markLibraryClipsUsedForJob,
};
