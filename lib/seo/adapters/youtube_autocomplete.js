'use strict';
/**
 * CPD-1207 — YouTube autocomplete adapter (real search demand, no API key).
 *
 * Uses the public suggest endpoint (client=firefox&ds=yt) which returns
 * ["seed", ["suggestion1", ...]] — the same completions the YouTube search
 * box shows. Suggestion order is a demand proxy: position 0 is what people
 * actually type most.
 */

const axios = require('axios');

const SUGGEST_URL = 'https://suggestqueries.google.com/complete/search';

async function fetchSuggestions(seed, opts = {}) {
  const q = String(seed || '').trim();
  if (!q) return [];
  const fetchImpl = opts.fetchImpl || defaultFetch;
  const raw = await fetchImpl(q, opts);
  if (!Array.isArray(raw) || !Array.isArray(raw[1])) return [];
  return raw[1]
    .map((s) => (Array.isArray(s) ? s[0] : s))
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s, i) => ({ keyword: s.trim().toLowerCase(), position: i, seed: q.toLowerCase() }));
}

async function defaultFetch(q, opts = {}) {
  const res = await axios.get(SUGGEST_URL, {
    params: { client: 'firefox', ds: 'yt', hl: opts.lang || 'en', gl: opts.region || 'US', q },
    timeout: 10_000,
    responseType: 'text',
    transformResponse: [(d) => d],
  });
  return JSON.parse(res.data);
}

/**
 * Expand seed keywords into demand-ordered suggestion lists.
 * Returns unique keywords with best (lowest) position across seeds.
 */
async function expandKeywords(seeds = [], opts = {}) {
  const limitSeeds = (opts.maxSeeds || 8);
  const results = [];
  for (const seed of seeds.slice(0, limitSeeds)) {
    try {
      results.push(...await fetchSuggestions(seed, opts));
    } catch {
      /* individual seed failures are non-fatal */
    }
  }
  const best = new Map();
  for (const r of results) {
    const prev = best.get(r.keyword);
    if (!prev || r.position < prev.position) best.set(r.keyword, r);
  }
  return [...best.values()].sort((a, b) => a.position - b.position);
}

module.exports = { fetchSuggestions, expandKeywords };
