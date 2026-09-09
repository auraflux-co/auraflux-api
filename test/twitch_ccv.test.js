'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatOffset } = require('../lib/twitch_ccv');

test('formatOffset clocks peak position', () => {
  assert.equal(formatOffset(0), '0:00');
  assert.equal(formatOffset(65), '1:05');
  assert.equal(formatOffset(3723), '1:02:03');
  assert.equal(formatOffset(null), null);
});
