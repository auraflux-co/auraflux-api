'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isYoutubeLiveStatus, isYoutubeStaleStatus } = require('../lib/live_grid/youtube_sync');

describe('youtube_sync', () => {
  it('isYoutubeLiveStatus recognizes live and testing', () => {
    assert.equal(isYoutubeLiveStatus('live'), true);
    assert.equal(isYoutubeLiveStatus('testing'), true);
    assert.equal(isYoutubeLiveStatus('complete'), false);
    assert.equal(isYoutubeLiveStatus('ready'), false);
  });

  it('isYoutubeStaleStatus only flags complete', () => {
    assert.equal(isYoutubeStaleStatus('complete'), true);
    assert.equal(isYoutubeStaleStatus('ready'), false);
    assert.equal(isYoutubeStaleStatus('live'), false);
  });
});
