'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { injectSceneResetHoldsInScript } = require('../lib/soup_scene_reset_holds');

describe('scene reset holds', () => {
  it('adds leading scene hold on streamer intro and outro', () => {
    const script = `=== INTRO ===
Welcome.

=== CINNA_INTRO ===
First up Cinna.

=== OUTRO ===
Goodnight.
`;
    const out = injectSceneResetHoldsInScript(script);
    assert.match(out, /=== CINNA_INTRO ===\n\[scene hold\]/);
    assert.match(out, /=== OUTRO ===\n\[scene hold\]/);
    assert.doesNotMatch(out, /=== INTRO ===\n\[scene hold\]/);
  });
});
