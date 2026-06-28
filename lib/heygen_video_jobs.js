'use strict';

/**
 * Normalize HeyGen videoJobs sceneIndex from script.scenes order.
 * Partial re-renders can leave stale indices and unsorted arrays — assembly
 * segment lookup is by sceneName, but pollers and legacy paths sort by sceneIndex.
 */
function normalizeHeygenVideoJobs(card = {}) {
  const scenes = card?.script?.scenes || [];
  const jobs = card?.heygen?.videoJobs;
  if (!Array.isArray(jobs) || !jobs.length || !scenes.length) {
    return { jobs: jobs || [], changed: false };
  }

  const nameToIndex = {};
  scenes.forEach((s, i) => {
    const key = String(s.name || s.id || '').trim().toUpperCase();
    if (key) nameToIndex[key] = i;
  });

  let changed = false;
  const normalized = jobs.map((j) => {
    const key = String(j.sceneName || '').trim().toUpperCase();
    const idx = nameToIndex[key];
    if (idx === undefined) return j;
    if (j.sceneIndex !== idx) {
      changed = true;
      return { ...j, sceneIndex: idx };
    }
    return j;
  });

  const sorted = [...normalized].sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0));
  const orderChanged = sorted.some((j, i) => j !== normalized[i]);
  if (orderChanged) changed = true;

  return { jobs: sorted, changed };
}

function applyNormalizedHeygenVideoJobs(card = {}) {
  const { jobs, changed } = normalizeHeygenVideoJobs(card);
  if (!changed || !card.heygen) return { card, changed: false };
  card.heygen.videoJobs = jobs;
  return { card, changed: true };
}

module.exports = {
  normalizeHeygenVideoJobs,
  applyNormalizedHeygenVideoJobs,
};
