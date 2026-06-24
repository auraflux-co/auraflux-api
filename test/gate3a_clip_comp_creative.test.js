'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGate3aGeminiSamplePrompt } = require('../lib/gates/gate3a');
const { buildClipCompDesignSpec } = require('../lib/clip_comp');

test('Gate 3a ranked clip-comp prompt expects Stream Serpent overlay not broadcast sidebar', () => {
  const designSpec = buildClipCompDesignSpec({
    clipCount: 5,
    compCreativePreset: 'serpent_ranked',
    streamerHint: 'Cinna',
  });
  const jobSpec = {
    designSpec,
    compCreative: designSpec.compCreative,
    order: { inputs: { items: [] } },
  };
  const ctx = {
    SAMPLE_DURATION: 10,
    confirmedFormat: '9:16',
    expectedSkin: 'twitch',
    chromeCfg: designSpec.chrome,
    clipCount: 5,
    totalScenes: 5,
    sceneHeaders: ['CLIP_1', 'CLIP_2', 'CLIP_3', 'CLIP_4', 'CLIP_5'],
    clipSceneIndices: [0, 1, 2, 3, 4],
    earlySceneLabel: 'CLIP_1',
    priorContext: 'test',
    sampleStartSec: 15,
  };
  const { prompt } = buildGate3aGeminiSamplePrompt(jobSpec, 'early', ctx);
  assert.ok(prompt.includes('Stream Serpent RANKED'));
  assert.ok(prompt.includes('NOT the broadcast sidebar'));
  assert.ok(prompt.includes('Logo: OFF'));
  assert.ok(!prompt.includes('220px logo') || prompt.includes('Logo: OFF'));
  assert.ok(prompt.includes('source clips ARE source clips'));
});
