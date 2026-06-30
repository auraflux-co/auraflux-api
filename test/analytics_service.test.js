'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('analytics facade (CPD-1192)', () => {
  it('registers youtube adapter', () => {
    const analytics = require('../lib/analytics');
    const adapter = analytics.getAdapter('youtube');
    assert.equal(typeof adapter.fetchVideoMetrics, 'function');
    assert.equal(typeof adapter.fetchChannelSummary, 'function');
    assert.equal(typeof adapter.analyticsReady, 'function');
  });

  it('isAnalyticsReady returns boolean without throwing', () => {
    const analytics = require('../lib/analytics');
    const ready = analytics.isAnalyticsReady('youtube');
    assert.equal(typeof ready, 'boolean');
  });

  it('throws for unknown platform', () => {
    const analytics = require('../lib/analytics');
    assert.throws(() => analytics.getAdapter('tiktok'), /No analytics adapter/);
  });
});
