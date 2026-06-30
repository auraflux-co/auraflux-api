'use strict';
/**
 * CPD-1190 — SEO / keyword intelligence (extends publish copy; no duplicate APIs).
 */

function normalizeKeyword(raw) {
  return String(raw || '').trim().replace(/^#/, '').toLowerCase();
}

function uniqueKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const k = normalizeKeyword(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Extract keyword candidates already produced by publish copy generation.
 */
function extractKeywordsFromPublishCopy(publishCopy = {}) {
  const seo = publishCopy.seo || {};
  const youtube = publishCopy.youtube || {};
  return uniqueKeywords([
    ...(seo.primaryKeywords || []),
    ...(seo.longTailKeywords || []),
    ...(seo.trendingPhrases || []),
    ...(youtube.tags || []),
    ...(youtube.hashtags || []),
  ]);
}

/**
 * Build keyword intelligence block for downstream prompts.
 * Future: merge Reddit/Trends adapters here without changing callers.
 */
function buildKeywordContext({ publishCopy, intelligenceContext, limit = 30 } = {}) {
  const fromCopy = extractKeywordsFromPublishCopy(publishCopy);
  const fromHistory = intelligenceContext?.topTags || [];
  const merged = uniqueKeywords([...fromHistory, ...fromCopy]).slice(0, limit);

  return {
    ok: true,
    keywords: merged,
    sources: {
      publishCopy: fromCopy.length,
      historical: fromHistory.length,
    },
    sampleSize: intelligenceContext?.sampleSize || 0,
  };
}

module.exports = {
  normalizeKeyword,
  uniqueKeywords,
  extractKeywordsFromPublishCopy,
  buildKeywordContext,
};
