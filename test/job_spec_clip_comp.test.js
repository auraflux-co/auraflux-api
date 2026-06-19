'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDesignSpec, loadCustomerConfig } = require('../lib/job_spec');
const { buildClipCompDesignSpec } = require('../lib/clip_comp');

test('buildDesignSpec for twitch-short clip comp declares clip-comp layout', () => {
  const cust = loadCustomerConfig('c0');
  const spec = buildDesignSpec(cust, 'short-form', 'twitch-short');
  const merged = buildClipCompDesignSpec({ clipCount: 3, sourceContentType: 'twitch-short', base: spec });
  assert.equal(merged.chrome.layout, 'clip-comp');
  assert.equal(merged.expectedClipCount, 3);
  assert.equal(merged.audio.mixMode, 'source');
});
