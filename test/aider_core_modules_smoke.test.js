'use strict';

/**
 * Smoke tests for core pipeline modules flagged in aider_session_review_local.md
 * (lib/assembly.js, lib/job_spec.js, lib/gates/) — export surface only, no live I/O.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('lib/assembly.js exports handleAssemble', () => {
  const asm = require('../lib/assembly');
  assert.equal(typeof asm.handleAssemble, 'function');
});

test('lib/job_spec.js exports spec helpers', () => {
  const js = require('../lib/job_spec');
  assert.equal(typeof js.createJobSpec, 'function');
  assert.equal(typeof js.linkScriptJob, 'function');
});

test('lib/gates/gate1.js re-exports portal1 run', () => {
  const g1 = require('../lib/gates/gate1');
  assert.equal(typeof g1.run, 'function');
});

test('lib/gates/gate3a.js exports run', () => {
  const g3a = require('../lib/gates/gate3a');
  assert.equal(typeof g3a.run, 'function');
});

test('lib/gates/gate3b.js re-exports portal3b run', () => {
  const g3b = require('../lib/gates/gate3b');
  assert.equal(typeof g3b.run, 'function');
});
