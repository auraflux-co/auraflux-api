'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../lib/portals/portal3b');

test('Gate 3b skips logoPosition mismatch for clip-comp chrome', async () => {
  const jobSpec = {
    jobId: 'test_clip_comp',
    contentType: 'twitch-short',
    customerId: 'c0',
    designSpec: {
      chrome: {
        layout: 'clip-comp',
        logoPosition: 'top-blur-fold',
        hasLogo: true,
        hasTopBar: false,
        hasFlag: false,
        hasSidebar: false,
      },
      expectedClipCount: 4,
    },
    commitments: {},
    order: { designSpec: {} },
  };

  const gate3aReport = {
    passed: true,
    outcome: 'pass',
    score: 65,
    sampleFindings: { early: { portraitSplitCorrect: true } },
    upstreamContext: { confirmedClean: [], escalatedConcerns: [] },
  };

  const result = await run(jobSpec, gate3aReport, [
    { passed: true, upstreamContext: { confirmedClean: [], escalatedConcerns: [] } },
    { passed: true, upstreamContext: { confirmedClean: [], escalatedConcerns: [] } },
    { passed: true, upstreamContext: { confirmedClean: [], escalatedConcerns: [] } },
  ]);

  const fields = result.mismatches.map((m) => m.field);
  assert.ok(!fields.includes('chrome.logoPosition'), `unexpected logoPosition mismatch: ${JSON.stringify(result.mismatches)}`);
});
