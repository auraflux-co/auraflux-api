'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  scriptHash,
  isTwitchLongForm,
  buildSceneOrderPreflight,
  confirmSceneOrder,
  assertSceneOrderGate,
  invalidateSceneOrderConfirm,
} = require('../lib/scene_order_gate');

describe('scene_order_gate', () => {
  const sampleScript = '=== INTRO ===\nHello\n\n=== JASON_CLIP1_SETUP ===\nSetup\n\n=== OUTRO ===\nBye';

  it('isTwitchLongForm detects twitch compilation', () => {
    assert.equal(isTwitchLongForm({ contentType: 'twitch' }), true);
    assert.equal(isTwitchLongForm({ contentType: 'twitch-short' }), false);
    assert.equal(isTwitchLongForm({ contentType: 'twitch', clipsOnly: true }), false);
  });

  it('buildSceneOrderPreflight parses scene rows', () => {
    const pre = buildSceneOrderPreflight({ script: sampleScript, contentType: 'twitch' });
    assert.equal(pre.ok, true);
    assert.equal(pre.rows.length, 3);
    assert.equal(pre.rows[0].name, 'INTRO');
  });

  it('confirmSceneOrder sets heygen timestamp and hash', () => {
    const card = { contentType: 'twitch', script: { raw: sampleScript } };
    const r = confirmSceneOrder(card, 'heygen', sampleScript);
    assert.equal(r.ok, true);
    assert.ok(r.card.sceneOrderHeygenConfirmedAt);
    assert.equal(r.card.sceneOrderScriptHash, scriptHash(sampleScript));
  });

  it('assertSceneOrderGate blocks without confirm', () => {
    const card = { contentType: 'twitch', script: { raw: sampleScript } };
    const g = assertSceneOrderGate(card, 'heygen', sampleScript);
    assert.equal(g.ok, false);
    assert.equal(g.code, 'scene_order_not_confirmed');
  });

  it('invalidateSceneOrderConfirm clears gates', () => {
    const card = confirmSceneOrder({ contentType: 'twitch', script: { raw: sampleScript } }, 'heygen', sampleScript).card;
    const cleared = invalidateSceneOrderConfirm(card);
    assert.equal(cleared.sceneOrderHeygenConfirmedAt, null);
  });
});
