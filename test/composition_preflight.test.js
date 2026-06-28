'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildProductionPreflight } = require('../lib/composition_preflight');
const { buildCompositionSpec, toGenerateClipCompJobs } = require('../lib/composition_spec');

describe('composition_preflight', () => {
  it('builds production brief with duration and assembly steps', () => {
    const { spec } = buildCompositionSpec({
      deliveryFormat: 'short',
      compCreativePreset: 'dahbluh_clean',
      clips: [{
        url: 'https://clips.twitch.tv/x',
        pageUrl: 'https://clips.twitch.tv/x',
        title: 'Test clip',
        streamer: 'test',
        displayName: 'Test',
        duration: 30,
        trimStart: 5,
        trimEnd: 25,
      }],
    });
    const pf = buildProductionPreflight(spec);
    assert.equal(pf.footageSec, 20);
    assert.equal(pf.clipCount, 1);
    assert.ok(pf.assemblySteps.length >= 4);
    assert.ok(pf.ffmpegFeatures.some((f) => f.key === 'trim' && f.active));
  });

  it('toGenerateClipCompJobs splits multi-clip short into N jobs', () => {
    const { spec } = buildCompositionSpec({
      deliveryFormat: 'short',
      compCreativePreset: 'full_bleed',
      clips: [
        { url: 'https://a', pageUrl: 'https://a', title: 'A', streamer: 'a', duration: 20, trimStart: 0, trimEnd: 20 },
        { url: 'https://b', pageUrl: 'https://b', title: 'B', streamer: 'b', duration: 15, trimStart: 0, trimEnd: 15 },
      ],
    });
    const jobs = toGenerateClipCompJobs(spec);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].clips.length, 1);
    assert.ok(jobs[0].compositionSpec);
  });
});
