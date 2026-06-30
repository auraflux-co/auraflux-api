'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('seo keywords (CPD-1190)', () => {
  it('extractKeywordsFromPublishCopy dedupes tags and hashtags', () => {
    const { extractKeywordsFromPublishCopy } = require('../lib/seo');
    const keys = extractKeywordsFromPublishCopy({
      seo: { primaryKeywords: ['Twitch Clip', 'Viral Moment'] },
      youtube: {
        tags: ['twitch clip', 'gaming'],
        hashtags: ['#ViralMoment', 'gaming'],
      },
    });
    assert.ok(keys.includes('twitch clip'));
    assert.ok(keys.includes('viral moment'));
    assert.ok(keys.includes('gaming'));
    assert.equal(keys.filter((k) => k === 'gaming').length, 1);
  });

  it('buildKeywordContext merges historical and publish copy', () => {
    const { buildKeywordContext } = require('../lib/seo');
    const block = buildKeywordContext({
      publishCopy: {
        seo: { primaryKeywords: ['nba highlights'] },
        youtube: { tags: ['basketball'] },
      },
      intelligenceContext: {
        sampleSize: 2,
        topTags: ['highlights', 'nba'],
      },
    });
    assert.equal(block.ok, true);
    assert.ok(block.keywords.includes('nba highlights'));
    assert.ok(block.keywords.includes('highlights'));
    assert.equal(block.sources.publishCopy, 2);
    assert.equal(block.sources.historical, 2);
  });
});
