'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasAnalyticsScope } = require('../lib/stats/adapters/youtube');

test('hasAnalyticsScope detects yt-analytics.readonly', () => {
  assert.equal(hasAnalyticsScope('https://www.googleapis.com/auth/yt-analytics.readonly'), true);
  assert.equal(hasAnalyticsScope('https://www.googleapis.com/auth/youtube.readonly'), false);
  assert.equal(hasAnalyticsScope(null), false);
});
