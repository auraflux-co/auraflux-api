'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hooksMatchBurned,
  markHookSelection,
  recordBurnedHooksOnCard,
  reconcileHooksPendingReassemble,
  assertReadyToPublish,
  resolveGate5PublishCopy,
} = require('../lib/operator_creative_guard');

test('hooksMatchBurned — matches when burned equals selected', () => {
  const card = { burnedHookTitles: ['Big play!'], clipHookTitles: ['Big play!'] };
  assert.equal(hooksMatchBurned(card), true);
});

test('hooksMatchBurned — fails when operator changed hook', () => {
  const card = { burnedHookTitles: ['Gemini default'], clipHookTitles: ['Operator pick'] };
  assert.equal(hooksMatchBurned(card), false);
});

test('markHookSelection sets pending reassemble', () => {
  const card = { clipCompBrief: { clips: [{ hook: 'old' }] }, driveUrl: 'https://example.com/v.mp4' };
  markHookSelection(card, 0, 'New hook');
  assert.equal(card.hooksPendingReassemble, true);
  assert.equal(card.clipCompBrief.clips[0].hook, 'New hook');
});

test('markHookSelection — no pending when re-selecting same burned hook', () => {
  const card = {
    clipCompBrief: { clips: [{ hook: 'Same hook' }] },
    driveUrl: 'https://example.com/v.mp4',
    burnedHookTitles: ['Same hook'],
  };
  markHookSelection(card, 0, 'Same hook');
  assert.equal(card.hooksPendingReassemble, false);
});

test('markHookSelection — no pending before first assembly', () => {
  const card = { clipCompBrief: { clips: [{ hook: 'old' }] } };
  markHookSelection(card, 0, 'New hook');
  assert.equal(card.hooksPendingReassemble, false);
});

test('recordBurnedHooksOnCard clears pending flag', () => {
  const card = { hooksPendingReassemble: true };
  recordBurnedHooksOnCard(card, ['Burned line']);
  assert.equal(card.hooksPendingReassemble, false);
  assert.deepEqual(card.burnedHookTitles, ['Burned line']);
});

test('assertReadyToPublish blocks clip comp when hooks pending', () => {
  const card = { clipsOnly: true, hooksPendingReassemble: true };
  const r = assertReadyToPublish(card);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'hooks_pending_reassemble');
});

test('assertReadyToPublish blocks when burned hooks stale', () => {
  const card = {
    clipsOnly: true,
    hooksPendingReassemble: false,
    burnedHookTitles: ['Old'],
    clipHookTitles: ['New'],
  };
  const r = assertReadyToPublish(card);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'hooks_stale');
});

test('reconcileHooksPendingReassemble clears stale flag when hooks match', () => {
  const card = {
    clipsOnly: true,
    hooksPendingReassemble: true,
    burnedHookTitles: ['Same'],
    clipHookTitles: ['Same'],
  };
  assert.equal(reconcileHooksPendingReassemble(card), true);
  assert.equal(card.hooksPendingReassemble, false);
});

test('resolveGate5PublishCopy prefers operator-locked card publishCopy', () => {
  const card = {
    operatorTitleLocked: true,
    publishCopy: { title: 'Operator title', platforms: { youtube: { title: 'Operator title' } } },
    state: { savedOutputs: { publishCopy: { title: 'Stale DB title' } } },
  };
  const pc = resolveGate5PublishCopy(card);
  assert.equal(pc.title, 'Operator title');
});
