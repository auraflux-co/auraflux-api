'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDialNumber } = require('../lib/services/slack_slash_call');

test('normalizeDialNumber handles E.164 and US 10-digit', () => {
  assert.equal(normalizeDialNumber('+15714497652'), '+15714497652');
  assert.equal(normalizeDialNumber('5714497652'), '+15714497652');
  assert.equal(normalizeDialNumber('(571) 449-7652'), '+15714497652');
  assert.equal(normalizeDialNumber(''), null);
  assert.equal(normalizeDialNumber('abc'), null);
});

test('normalizeDialNumber handles 11-digit US', () => {
  assert.equal(normalizeDialNumber('15714497652'), '+15714497652');
});
