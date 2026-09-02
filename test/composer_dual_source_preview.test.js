'use strict';
/**
 * Smoke checks for C11 dual-stack Compose UI contracts mirrored from cwn_production.html.
 * Full DOM preview is browser-verified; this guards delivery/layout invariants.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'cwn_production.html'), 'utf8');

assert.ok(html.includes('function isComposerDualSourceStack()'), 'isComposerDualSourceStack defined');
assert.ok(html.includes('function applyComposerDualSourcePreviewPanes()'), 'dual preview panes defined');
assert.ok(html.includes("if (preset === 'dual_source_stack') return 'comp';"), 'delivery infers comp for dual');
assert.ok(html.includes('if (isComposerDualSourceStack()) return 2;'), 'lineup max slots = 2 for dual');
assert.ok(html.includes("mode === 'dual_source_vstack'"), 'overlay/look guards dual_source_vstack');
assert.ok(html.includes('is-dual-source'), 'CSS dual-source frame class');
assert.ok(html.includes('composer-dual-label-top-el'), 'TOP label element in preview');
assert.ok(html.includes('composer-dual-label-bottom-el'), 'BOTTOM label element in preview');
assert.ok(html.includes("THEN/NOW STACK"), 'lineup head copy for dual');
assert.ok(
  html.includes("compCreative.layout.mode === 'dual_source_vstack'")
    || html.includes("layout && compCreative.layout.mode === 'dual_source_vstack'"),
  'overlaySavedLook skips dual layout'
);
assert.ok(html.includes('if (isComposerDualSourceStack()) maxCount = 2;'), 'spec build forces 2 clips');

console.log('composer_dual_source_preview.test.js: ok');
