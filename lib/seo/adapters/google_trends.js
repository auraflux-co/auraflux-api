'use strict';
/**
 * CPD-1207 — Google Trends adapter (trending-topic overlap, no API key).
 *
 * The old /trends/api/dailytrends JSON endpoint returns 404 (deprecated 2025).
 * Current supported surface is the trending RSS feed:
 *   https://trends.google.com/trending/rss?geo=US
 * We parse it directly (title + ht:approx_traffic + ht:news_item_title) and
 * flag which of our keyword candidates ride a live trend.
 */

const axios = require('axios');

const TRENDING_RSS_URL = 'https://trends.google.com/trending/rss';

function parseTrendingRss(xml) {
  const out = [];
  const items = String(xml).split(/<item>/).slice(1);
  for (const chunk of items) {
    const title = (chunk.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    if (!title) continue;
    const traffic = (chunk.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1] || '';
    const newsTitles = [...chunk.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)]
      .map((m) => decodeEntities(m[1]).toLowerCase());
    out.push({
      query: decodeEntities(title).toLowerCase(),
      traffic: traffic.trim(),
      related: newsTitles,
      date: null,
    });
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

async function fetchDailyTrends(opts = {}) {
  const fetchImpl = opts.fetchImpl || defaultFetch;
  const data = await fetchImpl(opts);
  // Injected impls may return pre-parsed arrays; live path returns RSS XML.
  if (Array.isArray(data)) return data;
  return parseTrendingRss(data);
}

async function defaultFetch(opts = {}) {
  const res = await axios.get(TRENDING_RSS_URL, {
    params: { geo: opts.region || 'US' },
    timeout: 15_000,
    responseType: 'text',
    transformResponse: [(d) => d],
  });
  return res.data;
}

/**
 * Match our keyword candidates against live trending searches.
 * A keyword "matches" when it shares a whole word (len>2) with a trend query.
 */
function matchTrendingTopics(keywords = [], trends = []) {
  const matches = [];
  for (const kw of keywords) {
    const kwWords = new Set(String(kw).toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    if (!kwWords.size) continue;
    for (const t of trends) {
      const pool = [t.query, ...(t.related || [])];
      const hit = pool.find((q) => String(q).split(/\W+/).some((w) => w.length > 2 && kwWords.has(w)));
      if (hit) {
        matches.push({ keyword: kw, trend: t.query, matchedOn: hit, traffic: t.traffic });
        break;
      }
    }
  }
  return matches;
}

module.exports = { fetchDailyTrends, matchTrendingTopics, parseTrendingRss };
