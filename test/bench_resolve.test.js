'use strict';

describe('live_grid bench_resolve', () => {
  const orig = { ...process.env };

  afterEach(() => {
    process.env = { ...orig };
    jest.resetModules();
  });

  test('resolveLaunchBench uses env list when refresh throws', async () => {
    process.env.LIVE_GRID_BENCH = 'alpha,beta';
    const { resolveLaunchBench } = require('../lib/live_grid/bench_resolve');
    const bench = await resolveLaunchBench(async () => {
      const e = new Error('rate limit');
      e.response = { status: 429 };
      throw e;
    });
    expect(bench).toEqual(['alpha', 'beta']);
  });

  test('resolveLaunchBench uses default overnight list when refresh empty', async () => {
    delete process.env.LIVE_GRID_BENCH;
    const { resolveLaunchBench, DEFAULT_OVERNIGHT_BENCH } = require('../lib/live_grid/bench_resolve');
    const bench = await resolveLaunchBench(async () => []);
    expect(bench.length).toBe(DEFAULT_OVERNIGHT_BENCH.length);
    expect(bench).toContain('xqc');
  });
});
