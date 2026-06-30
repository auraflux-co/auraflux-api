'use strict';

const assert = require('assert');
const { normalizeInlineSceneHeaders, alignSceneHeadersToContract } = require('../lib/scaffold');
const { __test_validateStructureAgainstJobSpec: validate } = require('../lib/portals/portal1');

const inline = "=== INTRO ===Welcome=== CINNA_INTRO ===First up\n\n=== OUTRO ===Bye";
const normalized = normalizeInlineSceneHeaders(inline);
assert.match(normalized, /^=== INTRO ===\nWelcome/);
assert.match(normalized, /\n=== CINNA_INTRO ===\nFirst up/);

const jobSpec = {
  contentType: 'twitch',
  designSpec: {
    sceneStructure: {
      sceneHeaders: ['INTRO', 'CINNA_INTRO', 'OUTRO'],
      expectedClipCount: 0,
    },
  },
};

const misnamed = normalizeInlineSceneHeaders(
  '=== INTRO ===Hi=== EMILY_INTRO ===Emily bit=== OUTRO ===Bye',
);
const aligned = alignSceneHeadersToContract(misnamed, ['INTRO', 'EXTRAEMILY_INTRO', 'OUTRO']);
const check = validate(aligned, {
  ...jobSpec,
  designSpec: {
    sceneStructure: {
      sceneHeaders: ['INTRO', 'EXTRAEMILY_INTRO', 'OUTRO'],
      expectedClipCount: 0,
    },
  },
});
assert.equal(check.issues.length, 0, check.issues.join('; '));

console.log('normalize_inline_scene_headers.test.js: ok');
