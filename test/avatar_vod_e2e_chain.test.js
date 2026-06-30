'use strict';

/**
 * Avatar VOD Gate 1 chain — offline E2E for the validators production actually runs.
 * Catches dual-path bugs (portal1 pass + handoff fail) without Gemini or HeyGen credits.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeScriptForGate1 } = require('../lib/scaffold');
const { __test_validateStructureAgainstJobSpec: validateStructure } = require('../lib/portals/portal1');
const { buildSceneOrderPreflight } = require('../lib/scene_order_gate');
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
  contentType: 'twitch',
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

const card = {
  jobId: 'script_twitch_e2e_fixture',
  contentType: 'twitch',
  designSpec: jobSpec.designSpec,
};

// ── 1. Inline Gemini output has zero full-line headers (the production failure mode)
assert.equal(
  (inlineRaw.match(/^===\s*([A-Z0-9_]+)\s*===\s*$/gm) || []).length,
  0,
  'inline raw: no full-line headers',
);

// ── 2. Portal 1 structure check passes after normalize (path A)
const normalized = normalizeScriptForGate1(inlineRaw, expectedHeaders);
const structure = validateStructure(normalized, jobSpec);
assert.equal(structure.issues.length, 0, `portal1 structure: ${structure.issues.join('; ')}`);

// ── 3. Handoff review passes on the same inline blob (path B — was broken pre-CPD-1189)
(async () => {
  const gate1Result = { passed: true, outcome: 'pass', sceneStructureCorrect: true };
  const { review } = await runGateHandoffReview({
    jobId: card.jobId,
    gate: 'gate1',
    nextGate: 'gate2',
    contentType: 'twitch',
    jobSpec,
    script: inlineRaw,
    scriptForHeygen: inlineRaw,
    gateResult: gate1Result,
  });
  assert.equal(
    review.checks.sceneHeaders?.pass,
    true,
    `handoff headers: ${JSON.stringify(review.checks.sceneHeaders)}`,
  );
  assert.equal(review.passed, true, `handoff failed: ${review.issues.join('; ')}`);

  // ── 4. Saved-card shape: normalized script + scene-order preflight (HeyGen gate A)
  const savedScript = normalizeScriptForGate1(inlineRaw, expectedHeaders);
  const preflight = buildSceneOrderPreflight({
    card: { ...card, script: { raw: savedScript } },
    script: savedScript,
    contentType: 'twitch',
  });
  assert.equal(preflight.ok, true, `scene order preflight: ${preflight.blockers.join('; ')}`);
  assert.deepEqual(preflight.foundHeaders, expectedHeaders);

  // ── 5. Editor resubmit path: heygen/send-approved normalizes inline editor text
  const editorInline = inlineRaw;
  const editorNorm = normalizeScriptForGate1(editorInline, expectedHeaders);
  const editorPreflight = buildSceneOrderPreflight({
    card: { ...card, script: { raw: editorNorm } },
    script: editorNorm,
  });
  assert.equal(editorPreflight.ok, true, 'editor script after normalize must pass scene order');

  console.log('avatar_vod_e2e_chain.test.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
