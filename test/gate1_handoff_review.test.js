'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeScriptForGate1 } = require('../lib/scaffold');
const {
  __test_runGateHandoffReview: runGateHandoffReview,
  __test_parseSceneHeadersFromScript: parseSceneHeadersFromScript,
} = require('../lib/script_gen');

const fixturePath = path.join(__dirname, 'fixtures/inline_twitch_soup_script_snippet.txt');
const inlineRaw = fs.readFileSync(fixturePath, 'utf8');

const expectedHeaders = [
  'INTRO', 'CINNA_INTRO', 'CINNA_CLIP1_SETUP', 'CINNA_CLIP1_REACTION',
  'EXTRAEMILY_INTRO', 'OUTRO',
];

const jobSpec = {
  designSpec: {
    sceneStructure: {
      sceneHeaders: expectedHeaders,
      expectedClipCount: 1,
    },
  },
  state: {
    gateResults: {
      gate0: { passed: true, outcome: 'pass' },
      gate1: { passed: true, outcome: 'pass' },
    },
  },
};

assert.equal(
  (inlineRaw.match(/^===\s*([A-Z0-9_]+)\s*===\s*$/gm) || []).length,
  0,
  'inline fixture has no full-line headers before normalize',
);

const aligned = normalizeScriptForGate1(inlineRaw, expectedHeaders);
assert.deepEqual(parseSceneHeadersFromScript(aligned), expectedHeaders);

(async () => {
  const { review } = await runGateHandoffReview({
    jobId: 'gate1_handoff_fixture',
    gate: 'gate1',
    nextGate: 'gate2',
    contentType: 'twitch',
    jobSpec,
    script: inlineRaw,
    scriptForHeygen: inlineRaw,
    gateResult: { passed: true, outcome: 'pass' },
  });
  assert.equal(review.passed, true, review.issues.join('; '));
  console.log('gate1_handoff_review.test.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
