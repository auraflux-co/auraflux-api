'use strict';

const path = require('path');
const {
  YT_1080P30_MAX_K,
  YT_720P30_HIGH_K,
  BENCHMARK_STEPS,
  loadProfileEnv,
  buildEncodeContractSnapshot,
  applyBenchmarkStepEnv,
  getBenchmarkStepSpec,
} = require('../lib/live_grid/encode_contract');
const { resolveProfilePath } = require('../lib/live_grid/render_profile');

describe('encode_contract (CPD-1063)', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  test('benchmark steps 0–4 are defined', () => {
    expect(Object.keys(BENCHMARK_STEPS).sort()).toEqual(['0', '1', '2', '3', '4']);
    expect(getBenchmarkStepSpec(3).label).toBe('full_stack_tier_b');
  });

  test('tier B profile loads main 6800k + solos 4500k @ 720p', () => {
    const loaded = loadProfileEnv('tier_b');
    expect(loaded.error).toBeUndefined();
    expect(loaded.env.LIVE_GRID_BITRATE_K).toBe('6800');
    expect(loaded.env.LIVE_GRID_SOLO_1_BITRATE_K).toBe('4500');
    expect(loaded.env.LIVE_GRID_SOLO_1_OUTPUT_H).toBe('720');
  });

  test('tier C profile loads uniform 6800k @ 1080p', () => {
    const loaded = loadProfileEnv('tier_c');
    expect(loaded.env.LIVE_GRID_SOLO_4_BITRATE_K).toBe('6800');
    expect(loaded.env.LIVE_GRID_SOLO_4_OUTPUT_H).toBe('1080');
  });

  test('applyBenchmarkStepEnv step 3 sets tier B encode contract', () => {
    const spec = applyBenchmarkStepEnv(3);
    expect(spec.label).toBe('full_stack_tier_b');
    expect(process.env.LIVE_GRID_BITRATE_K).toBe('6800');
    expect(process.env.LIVE_GRID_SOLO_2_BITRATE_K).toBe('4500');
    expect(spec.encodeContract.totals.configuredVideoBitrateK).toBe(
      YT_1080P30_MAX_K + 4 * YT_720P30_HIGH_K
    );
  });

  test('applyBenchmarkStepEnv step 2 enables main + Q1 solo only', () => {
    const spec = applyBenchmarkStepEnv(2);
    expect(spec.soloSeats).toEqual([1]);
    expect(process.env.LIVE_GRID_SOLO_FOCUS).toBe('1');
    expect(process.env.LIVE_GRID_MAIN_ENCODE).toBe('on');
    expect(spec.encodeContract.totals.encoderCount).toBe(2);
  });

  test('buildEncodeContractSnapshot reflects runtime running state', () => {
    process.env.LIVE_GRID_BITRATE_K = '6800';
    process.env.LIVE_GRID_SOLO_1_BITRATE_K = '4500';
    process.env.LIVE_GRID_SOLO_1_OUTPUT_H = '720';
    const snap = buildEncodeContractSnapshot({
      mainRunning: true,
      soloRunning: [true, false, false, false],
    });
    expect(snap.main.running).toBe(true);
    expect(snap.main.meetsYoutubeTarget).toBe(true);
    expect(snap.totals.activeVideoBitrateK).toBe(YT_1080P30_MAX_K + YT_720P30_HIGH_K);
    expect(snap.totals.encoderCount).toBe(2);
  });

  test('resolveProfilePath honors LIVE_GRID_RENDER_PROFILE', () => {
    process.env.LIVE_GRID_RENDER_PROFILE = 'live_grid_profile_benchmark_tier_b.json';
    expect(resolveProfilePath()).toBe(
      path.join(__dirname, '..', 'config', 'live_grid_profile_benchmark_tier_b.json')
    );
    delete process.env.LIVE_GRID_RENDER_PROFILE;
  });
});
