'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeScriptForGate1 } = require('../lib/scaffold');

const fixturePath = path.join(__dirname, 'fixtures/inline_twitch_soup_script_snippet.txt');
const inlineRaw = fs.readFileSync(fixturePath, 'utf8');

const expectedHeaders = [
  'INTRO', 'CINNA_INTRO', 'CINNA_CLIP1_SETUP', 'CINNA_CLIP1_REACTION',
  'EXTRAEMILY_INTRO', 'OUTRO',
];

function parseSceneHeadersFromScript(script) {
  const { normalizeInlineSceneHeaders } = require('../lib/scaffold');
  const normalized = normalizeInlineSceneHeaders(script);
  return Array.from(normalized.matchAll(/^===\s*([A-Z0-9_]+)\s*===\s*$/gm))
    .map((m) => String(m[1] || '').trim())
    .filter(Boolean);
}

// Without align: EMILY stays wrong name but headers exist
const splitOnly = parseSceneHeadersFromScript(inlineRaw);
assert.ok(splitOnly.length >= 4, 'inline split yields headers');

const aligned = normalizeScriptForGate1(inlineRaw, expectedHeaders);
assert.deepEqual(parseSceneHeadersFromScript(aligned), expectedHeaders);

console.log('gate1_handoff_review.test.js: ok');
