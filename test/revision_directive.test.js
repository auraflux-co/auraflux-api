'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHeuristicDirective,
  buildPortal1FixDirective,
  applyRevisionDirectiveToJobSpec,
} = require('../lib/services/revision_directive');

test('buildHeuristicDirective maps script feedback to portal1 regen', () => {
  const d = buildHeuristicDirective({
    feedback: 'Make the intro shorter and fix the outro hook',
    categories: ['script'],
    source: 'customer',
  });
  assert.equal(d.needsScriptRegen, true);
  assert.ok(d.scriptChanges.length > 0);
  assert.equal(d.restartFromPortal, 'portal1');
  assert.equal(d.parsedBy, 'heuristic');
});

test('buildHeuristicDirective detects thumbnail changes', () => {
  const d = buildHeuristicDirective({
    feedback: 'The thumbnail text is too small',
    categories: ['thumbnail'],
  });
  assert.equal(d.thumbnailRegen, true);
  assert.ok(d.thumbnailChanges.length > 0);
});

test('applyRevisionDirectiveToJobSpec sets portal1FixDirective and forceScriptRegen', () => {
  const spec = { state: {}, order: {} };
  const directive = buildHeuristicDirective({
    feedback: 'Change the narration tone to be more energetic',
    categories: ['narration'],
  });
  applyRevisionDirectiveToJobSpec(spec, directive);
  assert.ok(spec.state.portal1FixDirective);
  assert.equal(spec.state.forceScriptRegen, true);
  assert.ok(spec.order.revisionContext);
  assert.equal(spec.state.assemblyFixDirective, directive);
});

test('buildPortal1FixDirective includes customer revision flag', () => {
  const fd = buildPortal1FixDirective({
    summary: 'Fix script',
    scriptChanges: ['Shorten intro'],
    source: 'operator',
  });
  assert.equal(fd.customerRevision, true);
  assert.equal(fd.revisionSource, 'operator');
  assert.ok(fd.delivered.includes('Fix script'));
});
