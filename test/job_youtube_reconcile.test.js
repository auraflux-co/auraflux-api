'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTitle,
  reconcileJobCardYouTube,
  findCatalogMatch,
} = require('../lib/job_youtube_reconcile');

const INDEX = {
  byVideoId: new Map([
    ['abc12345678', { id: 'abc12345678', title: 'TWITCH SOUP: Jason Spelling Bee', url: 'https://www.youtube.com/watch?v=abc12345678', published: '2026-06-20' }],
  ]),
  byTitle: new Map([
    ['twitch soup jason spelling bee', { id: 'abc12345678', title: 'TWITCH SOUP: Jason Spelling Bee', url: 'https://www.youtube.com/watch?v=abc12345678' }],
  ]),
  fetchedAt: '2026-06-29T00:00:00.000Z',
};

describe('job_youtube_reconcile', () => {
  it('normalizeTitle strips hashtags and punctuation', () => {
    assert.equal(normalizeTitle('#TWITCH SOUP: Jason!'), 'twitch soup jason');
  });

  it('promotes awaiting_review when gate5 YouTube URL is on catalog', () => {
    const result = reconcileJobCardYouTube({
      jobId: 'script_twitch_1',
      stage: 'awaiting_review',
      gate5Result: { platforms: { youtube: { url: 'https://youtu.be/abc12345678' } } },
    }, INDEX);
    assert.equal(result.changed, true);
    assert.equal(result.card.stage, 'published');
    assert.equal(result.youtubeConfirmed, true);
    assert.equal(result.match, 'url');
  });

  it('does not change already published cards', () => {
    const result = reconcileJobCardYouTube({
      jobId: 'script_twitch_2',
      stage: 'published',
      publishedAt: '2026-06-18T00:00:00.000Z',
      gate5Result: { platforms: { youtube: { url: 'https://www.youtube.com/watch?v=abc12345678' } } },
    }, INDEX);
    assert.equal(result.changed, false);
    assert.equal(result.youtubeConfirmed, true);
  });

  it('findCatalogMatch by exact title', () => {
    const match = findCatalogMatch({
      stage: 'assembled',
      title: 'TWITCH SOUP: Jason Spelling Bee',
    }, INDEX);
    assert.equal(match.match, 'title_exact');
    assert.equal(match.item.id, 'abc12345678');
  });

  it('leaves unmatched jobs unchanged', () => {
    const result = reconcileJobCardYouTube({
      jobId: 'script_twitch_3',
      stage: 'awaiting_review',
      title: 'Not on YouTube yet',
    }, INDEX);
    assert.equal(result.changed, false);
    assert.equal(result.youtubeConfirmed, false);
  });
});
