'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  autoPinForGate1Outcome,
  queuePinnedForGate1Save,
  normalizeLegacyQueuePin,
  sweepLegacyAutoPinnedFailures,
} = require('../lib/job_queue_policy');

test('autoPinForGate1Outcome — only pass pins queue', () => {
  assert.equal(autoPinForGate1Outcome('pass'), true);
  assert.equal(autoPinForGate1Outcome('fail'), false);
  assert.equal(autoPinForGate1Outcome('manual_review'), false);
});

test('queuePinnedForGate1Save', () => {
  const pass = queuePinnedForGate1Save({ outcome: 'pass' });
  assert.equal(pass.queuePinned, true);
  assert.equal(pass.operatorQueuePin, false);
  assert.ok(pass.queuePinnedAt);

  const fail = queuePinnedForGate1Save({ outcome: 'fail' });
  assert.equal(fail.queuePinned, false);
  assert.equal(fail.queuePinnedAt, null);
});

test('normalizeLegacyQueuePin unpins auto-pinned gate1 failures', () => {
  const card = { stage: 'gate1_failed', gate1Outcome: 'fail', queuePinned: true };
  const next = normalizeLegacyQueuePin(card);
  assert.equal(next.queuePinned, false);
  assert.equal(next.queueUnpinReason, 'gate1_not_approved');
});

test('normalizeLegacyQueuePin keeps operator-pinned failures', () => {
  const card = { stage: 'gate1_failed', queuePinned: true, operatorQueuePin: true };
  assert.equal(normalizeLegacyQueuePin(card).queuePinned, true);
});

test('sweepLegacyAutoPinnedFailures', () => {
  const jobs = {
    a: { stage: 'gate1_failed', queuePinned: true },
    b: { stage: 'script_ready', queuePinned: true },
  };
  const n = sweepLegacyAutoPinnedFailures(jobs);
  assert.equal(n, 1);
  assert.equal(jobs.a.queuePinned, false);
  assert.equal(jobs.b.queuePinned, true);
});
