'use strict';

describe('live_grid middleware_config', () => {
  const orig = { ...process.env };

  afterEach(() => {
    process.env = { ...orig };
    jest.resetModules();
  });

  test('flags default off', () => {
    delete process.env.LIVE_GRID_OUTPUT_MIDDLEWARE;
    delete process.env.LIVE_GRID_STAGED_SWAP;
    jest.resetModules();
    const cfg = require('../lib/live_grid/middleware_config');
    expect(cfg.outputMiddlewareEnabled()).toBe(false);
    expect(cfg.stagedSwapEnabled()).toBe(false);
  });

  test('flags on when env set', () => {
    process.env.LIVE_GRID_OUTPUT_MIDDLEWARE = 'on';
    process.env.LIVE_GRID_STAGED_SWAP = 'on';
    jest.resetModules();
    const cfg = require('../lib/live_grid/middleware_config');
    expect(cfg.outputMiddlewareEnabled()).toBe(true);
    expect(cfg.stagedSwapEnabled()).toBe(true);
  });
});

describe('live_grid grid_restreamer', () => {
  test('buildRestreamerArgs reads HLS and pushes FLV RTMP', () => {
    const { buildRestreamerArgs } = require('../lib/live_grid/grid_restreamer');
    const args = buildRestreamerArgs('/tmp/preview/index.m3u8', 'rtmp://a/live2/key');
    expect(args).toContain('-re');
    expect(args).toContain('/tmp/preview/index.m3u8');
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('flv');
    expect(args[args.length - 1]).toBe('rtmp://a/live2/key');
  });
});

describe('live_grid SwapController', () => {
  jest.useFakeTimers();

  test('onOffline debounces replace callback', async () => {
    const { SwapController } = require('../lib/live_grid/swap_controller');
    const replace = jest.fn().mockResolvedValue(undefined);
    const sc = new SwapController({ log: () => {}, onRequestReplace: replace, debounceMs: 5000 });
    sc.onOffline(1, 'foo');
    expect(sc.isSwapping(1)).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(replace).toHaveBeenCalledWith(1, 'foo');
    sc.stop();
  });
});
