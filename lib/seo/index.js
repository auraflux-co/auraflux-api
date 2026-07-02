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

/**
 * CPD-1207 — Demand-validated keyword context.
 * Expands seeds via YouTube autocomplete (real search completions) and flags
 * overlap with Google daily trends. Network calls are adapter-owned; failures
 * degrade to the plain keyword context.
 */
async function buildDemandContext({ publishCopy, intelligenceContext, seeds, region, limit = 30 } = {}) {
  const base = buildKeywordContext({ publishCopy, intelligenceContext, limit });
  const seedList = uniqueKeywords(seeds && seeds.length ? seeds : base.keywords).slice(0, 8);

  let suggestions = [];
  let trendMatches = [];
  try {
    const autocomplete = require('./adapters/youtube_autocomplete');
    suggestions = await autocomplete.expandKeywords(seedList, { region });
  } catch { /* degrade */ }
  try {
    const trends = require('./adapters/google_trends');
    const daily = await trends.fetchDailyTrends({ region });
    trendMatches = trends.matchTrendingTopics(
      uniqueKeywords([...base.keywords, ...suggestions.map((s) => s.keyword)]),
      daily,
    );
  } catch { /* degrade */ }

  // Demand-ranked list: autocomplete-validated first (by position), then the rest.
  const validated = suggestions.map((s) => s.keyword);
  const demandRanked = uniqueKeywords([...validated, ...base.keywords]).slice(0, limit);

  return {
    ...base,
    keywords: demandRanked,
    demand: {
      seeds: seedList,
      autocomplete: suggestions.slice(0, limit),
      trending: trendMatches,
      validatedCount: validated.length,
    },
  };
}

module.exports = {
  normalizeKeyword,
  uniqueKeywords,
  extractKeywordsFromPublishCopy,
  buildKeywordContext,
  buildDemandContext,
};
