'use strict';
/**
 * Flatten multi-platform publish-copy responses for QA + dashboard.
 * GPT returns rich metadata under `platforms.youtube`; callers must not
 * prefer a shallow top-level `youtube` stub created by mistake.
 */

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function normalizePublishCopyShape(pc = {}) {
  if (!pc || typeof pc !== 'object') return pc;
  const nested = pc.platforms && typeof pc.platforms === 'object' ? pc.platforms : null;

  const pickYoutube = () => {
    const top = pc.youtube;
    const deep = nested?.youtube;
    if (!top) return deep || null;
    if (!deep) return top;
    const topWords = countWords(top.description);
    const deepWords = countWords(deep.description);
    if (deepWords > topWords) return deep;
    if (topWords > deepWords) return top;
    const topHashes = (String(top.description || '').match(/#\w+/g) || []).length;
    const deepHashes = (String(deep.description || '').match(/#\w+/g) || []).length;
    return deepHashes >= topHashes ? deep : top;
  };

  const youtube = pickYoutube();
  const tiktok = pc.tiktok || nested?.tiktok || null;
  const instagram = pc.instagram || nested?.instagram || null;

  const out = { ...pc };
  if (youtube) out.youtube = youtube;
  if (tiktok) out.tiktok = tiktok;
  if (instagram) out.instagram = instagram;
  if (nested && !out.platforms) out.platforms = nested;
  return out;
}

module.exports = { normalizePublishCopyShape, countWords };
