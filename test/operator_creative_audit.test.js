'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordOperatorCreativeEdit, previousHookAt } = require('../lib/operator_creative_audit');
const { resolveHooksForAssembly } = require('../lib/clip_comp_hooks');

test('recordOperatorCreativeEdit appends to card audit log', () => {
  const card = { id: 'job_test' };
  recordOperatorCreativeEdit(card, {
    kind: 'hook_custom',
    clipIndex: 1,
    text: 'The Interview Gone Wrong!',
    previous: 'Doorway Shove, Then What?',
  });
  assert.equal(card.operatorCreativeAudit.length, 1);
  assert.equal(card.operatorCreativeAudit[0].kind, 'hook_custom');
  assert.equal(card.operatorCreativeAudit[0].text, 'The Interview Gone Wrong!');
  assert.equal(card.operatorCreativeAudit[0].previous, 'Doorway Shove, Then What?');
});

test('previousHookAt reads current clip hook', () => {
  const card = { clipHookTitles: ['Hook A', 'Hook B'] };
  assert.equal(previousHookAt(card, 1), 'Hook B');
});

test('resolveHooksForAssembly skips Hook Machine when operatorLocked', async () => {
  const hooks = ['Happy Before the Interview!', 'The Interview Gone Wrong!'];
  const result = await resolveHooksForAssembly({
    hookClips: [{ title: 'a' }, { title: 'b' }],
    hookItems: [],
    preGenerated: hooks,
    operatorLocked: true,
    log: () => {},
  });
  assert.deepEqual(result.hooks, hooks);
  assert.equal(result.operatorLocked, true);
});
