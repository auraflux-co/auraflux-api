'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  diffGrid,
  filterActionableHealthIssues,
  computeStabilityTick,
  STABLE_TICKS_REQUIRED,
} = require('../lib/live_grid/stability_tracker');

describe('stability_tracker', () => {
  it('ignores baseline heavy_sources from actionable list', () => {
    const { baseline, actionable } = filterActionableHealthIssues(['heavy_sources', 'total_ffmpeg_cpu', 'master_down']);
    assert.deepEqual(baseline, ['heavy_sources', 'total_ffmpeg_cpu']);
    assert.deepEqual(actionable, ['master_down']);
  });

  it('detects audio routing change', () => {
    const prev = {
      onAirQuad: 1,
      onAirLogin: 'a',
      audioMode: 'manual',
      roster: 'Q1:a|Q2:b|Q3:c|Q4:d',
      quadrants: [{ quadrant: 1, login: 'a' }, { quadrant: 2, login: 'b' }],
    };
    const next = {
      onAirQuad: 2,
      onAirLogin: 'b',
      audioMode: 'manual',
      roster: 'Q1:a|Q2:b|Q3:c|Q4:d',
      quadrants: [{ quadrant: 1, login: 'a' }, { quadrant: 2, login: 'b' }],
    };
    const changes = diffGrid(prev, next);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'audio_routing');
  });

  it('detects grid swap', () => {
    const prev = {
      onAirQuad: 2,
      onAirLogin: 'b',
      roster: 'Q1:a|Q2:b|Q3:c|Q4:d',
      quadrants: [{ quadrant: 4, login: 'd' }],
    };
    const next = {
      onAirQuad: 2,
      onAirLogin: 'b',
      roster: 'Q1:a|Q2:b|Q3:c|Q4:e',
      quadrants: [{ quadrant: 4, login: 'e' }],
    };
    const changes = diffGrid(prev, next);
    assert.ok(changes.some((c) => c.type === 'grid_swap' && c.quad === 4));
  });

  it('marks stable after enough green ticks', () => {
    const prev = { stableStreak: STABLE_TICKS_REQUIRED - 1, lastGrid: null };
    const grid = {
      running: true,
      audio: { quadrant: 2, login: 'x', mode: 'manual' },
      quadrants: [
        { quadrant: 1, login: 'a' },
        { quadrant: 2, login: 'x' },
        { quadrant: 3, login: 'c' },
        { quadrant: 4, login: 'd' },
      ],
    };
    const tick = computeStabilityTick({
      prevState: prev,
      gridStatus: grid,
      healthTick: { issues: ['heavy_sources'], relayChurn: [0, 0, 0, 0], masterRestarts: 0 },
      avProbeTick: { videoLevel: 'good', audioLevel: 'good', videoScore: 100, audioScore: 100 },
    });
    assert.equal(tick.isStable, true);
    assert.equal(tick.level, 'stable');
  });

  it('resets streak on critical av audio', () => {
    const prev = { stableStreak: 5, lastGrid: null };
    const tick = computeStabilityTick({
      prevState: prev,
      gridStatus: { audio: { quadrant: 1 }, quadrants: [] },
      healthTick: { relayChurn: [0, 0, 0, 0], masterRestarts: 0 },
      avProbeTick: { videoLevel: 'good', audioLevel: 'critical', audioIssues: ['Q1: silent'] },
    });
    assert.equal(tick.stableStreak, 0);
    assert.ok(tick.blockers.includes('av_audio_critical'));
  });
});
