'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractYoutubeVideoId,
  enrichPublishDescription,
  resolveVodCompContentType,
} = require('../lib/clip_comp_publish');

test('extractYoutubeVideoId parses url and bare id', () => {
  assert.equal(extractYoutubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('enrichPublishDescription appends related VOD link once', () => {
  const desc = enrichPublishDescription('Hook short.', {
    delivery: { relatedVideoParentId: 'dQw4w9WgXcQ' },
  });
  assert.ok(desc.includes('youtu.be/dQw4w9WgXcQ'));
});

test('resolveVodCompContentType maps twitch-short', () => {
  assert.equal(resolveVodCompContentType('twitch-short'), 'twitch-vod-comp');
});
