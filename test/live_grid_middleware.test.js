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
  test('buildRestreamerArgs — local HLS has no -re; remote URL paces realtime', () => {
    const { buildRestreamerArgs } = require('../lib/live_grid/grid_restreamer');
    const local = buildRestreamerArgs('/tmp/preview/index.m3u8', 'rtmp://a/live2/key');
    expect(local).not.toContain('-re');
    expect(local).toContain('/tmp/preview/index.m3u8');
    expect(local[local.indexOf('-f') + 1]).toBe('flv');

    const remote = buildRestreamerArgs('http://127.0.0.1/preview/index.m3u8', 'rtmp://a/live2/key');
    expect(remote).toContain('-re');
    expect(remote[remote.length - 1]).toBe('rtmp://a/live2/key');
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
