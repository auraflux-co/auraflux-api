'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  normalizeScriptForGate1,
  normalizeInlineSceneHeaders,
} = require('../lib/scaffold');
const { __test_validateStructureAgainstJobSpec: validateStructure } = require('../lib/portals/portal1');

const fixturePath = path.join(__dirname, 'fixtures/inline_twitch_soup_script_snippet.txt');
const inlineRaw = fs.readFileSync(fixturePath, 'utf8');

const expectedHeaders = [
  'INTRO', 'CINNA_INTRO', 'CINNA_CLIP1_SETUP', 'CINNA_CLIP1_REACTION',
  'EXTRAEMILY_INTRO', 'OUTRO',
];

const jobSpec = {
  contentType: 'twitch',
  designSpec: {
    sceneStructure: {
      sceneHeaders: expectedHeaders,
      expectedClipCount: 1,
    },
  },
};

assert.equal(
  (inlineRaw.match(/^===\s*([A-Z0-9_]+)\s*===\s*$/gm) || []).length,
  0,
  'fixture must start with zero full-line headers (simulates Gemini inline output)',
);

const normalized = normalizeScriptForGate1(inlineRaw, expectedHeaders);
const check = validateStructure(normalized, jobSpec);
assert.equal(check.issues.length, 0, check.issues.join('; '));
assert.deepEqual(check.foundHeaders, expectedHeaders);

assert.ok(
  normalized.includes('=== EXTRAEMILY_INTRO ==='),
  'EMILY_INTRO rewritten to EXTRAEMILY_INTRO per jobSpec contract',
);

const v1only = normalizeInlineSceneHeaders(inlineRaw);
assert.ok(
  (v1only.match(/^===\s*([A-Z0-9_]+)\s*===\s*$/gm) || []).length >= 4,
  'v2 inline normalizer splits mid-line headers',
);

console.log('avatar_vod_gate1_structure.test.js: ok');
