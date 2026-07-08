'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveSourceReviewWindow,
  MAX_SOURCE_REVIEW_SEC,
} = require('../lib/composition_preview');

describe('composition source review (CPD-1234)', () => {
  it('uses full trim window when under max', () => {
    const w = resolveSourceReviewWindow(5, 45);
    assert.equal(w.trimStart, 5);
    assert.equal(w.windowSec, 40);
    assert.equal(w.trimEnd, 45);
    assert.equal(w.capped, false);
  });

  it('caps long trim windows at MAX_SOURCE_REVIEW_SEC', () => {
    const w = resolveSourceReviewWindow(0, 600, 180);
    assert.equal(w.windowSec, 180);
    assert.equal(w.trimEnd, 180);
    assert.equal(w.capped, true);
  });

  it('MAX_SOURCE_REVIEW_SEC is larger than layout preview loop', () => {
    assert.ok(MAX_SOURCE_REVIEW_SEC >= 60);
  });
});
