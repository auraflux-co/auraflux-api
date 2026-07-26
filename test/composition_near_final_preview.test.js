'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('composition near-final preview (CPD-1291)', () => {
  it('exports applyNearFinalPreviewStack and wires Review fields', () => {
    const mod = require('../lib/composition_preview');
    assert.equal(typeof mod.applyNearFinalPreviewStack, 'function');
    assert.equal(typeof mod.renderCompositionTimelinePreview, 'function');
    const src = fs.readFileSync(path.join(__dirname, '../lib/composition_preview.js'), 'utf8');
    assert.match(src, /nearFinalPreview/);
    assert.match(src, /nearFinalApplied/);
    assert.match(src, /whisper_captions/);
    assert.match(src, /applyCameraFx/);
    assert.match(src, /mixCompAudio/);
    assert.match(src, /applyClipCompTransform/);
  });

  it('UI labels Review as near-final', () => {
    const html = fs.readFileSync(path.join(__dirname, '../cwn_production.html'), 'utf8');
    assert.match(html, /Review near-final/);
    assert.match(html, /_composerNearFinalLast/);
    assert.match(html, /NEAR-FINAL REVIEW/);
  });
});
