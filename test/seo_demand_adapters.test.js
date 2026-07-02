'use strict';
/**
 * CPD-1207 — SEO demand adapters (autocomplete + trends) tests.
 * Network is stubbed via fetchImpl injection.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('seo demand adapters (CPD-1207)', () => {
  it('fetchSuggestions parses suggest payload with positions', async () => {
    const { fetchSuggestions } = require('../lib/seo/adapters/youtube_autocomplete');
    const out = await fetchSuggestions('ron fortnite', {
      fetchImpl: async () => ['ron fortnite', ['ron fortnite rage', 'ron fortnite crashout', 'ron fortnite live']],
    });
    assert.equal(out.length, 3);
    assert.equal(out[0].keyword, 'ron fortnite rage');
    assert.equal(out[0].position, 0);
    assert.equal(out[2].position, 2);
  });

  it('expandKeywords dedupes across seeds keeping best position', async () => {
    const { expandKeywords } = require('../lib/seo/adapters/youtube_autocomplete');
    const payloads = {
      a: ['a', ['shared kw', 'only a']],
      b: ['b', ['only b', 'shared kw']],
    };
    const out = await expandKeywords(['a', 'b'], {
      fetchImpl: async (q) => payloads[q],
    });
    const shared = out.find((k) => k.keyword === 'shared kw');
    assert.equal(shared.position, 0);
    assert.equal(out.length, 3);
  });

  it('expandKeywords survives per-seed failures', async () => {
    const { expandKeywords } = require('../lib/seo/adapters/youtube_autocomplete');
    const out = await expandKeywords(['ok', 'boom'], {
      fetchImpl: async (q) => {
        if (q === 'boom') throw new Error('network');
        return ['ok', ['ok result']];
      },
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].keyword, 'ok result');
  });

  it('fetchDailyTrends parses trending RSS', async () => {
    const { fetchDailyTrends } = require('../lib/seo/adapters/google_trends');
    const rss = `<?xml version="1.0"?><rss><channel><title>Trending</title>
      <item><title>Fortnite Chapter 7</title><ht:approx_traffic>500K+</ht:approx_traffic>
      <ht:news_item><ht:news_item_title>Fortnite new season launches</ht:news_item_title></ht:news_item></item>
      <item><title>NBA Finals</title><ht:approx_traffic>200K+</ht:approx_traffic></item>
      </channel></rss>`;
    const out = await fetchDailyTrends({ fetchImpl: async () => rss });
    assert.equal(out.length, 2);
    assert.equal(out[0].query, 'fortnite chapter 7');
    assert.equal(out[0].traffic, '500K+');
    assert.deepEqual(out[0].related, ['fortnite new season launches']);
  });

  it('matchTrendingTopics matches on shared words', () => {
    const { matchTrendingTopics } = require('../lib/seo/adapters/google_trends');
    const trends = [
      { query: 'fortnite chapter 7', traffic: '500K+', related: ['fortnite new season'] },
      { query: 'nba finals', traffic: '200K+', related: [] },
    ];
    const matches = matchTrendingTopics(['ron fortnite crashout', 'cooking pasta'], trends);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].keyword, 'ron fortnite crashout');
    assert.equal(matches[0].trend, 'fortnite chapter 7');
  });

  it('buildDemandContext degrades gracefully when adapters fail', async () => {
    const seo = require('../lib/seo');
    const block = await seo.buildDemandContext({
      publishCopy: { youtube: { tags: ['ron', 'fortnite'] } },
      seeds: [],
      // no fetchImpl injection here — real network may fail; context must still return
    });
    assert.equal(block.ok, true);
    assert.ok(Array.isArray(block.keywords));
    assert.ok(block.demand);
    assert.ok(Array.isArray(block.demand.autocomplete));
  });
});
