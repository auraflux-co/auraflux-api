const {
  isLegacyDualBroadcastEnabled,
  resolveVerticalStream,
} = require('../lib/live_grid/dual_broadcast');

describe('live_grid dual_broadcast (CPD-1029)', () => {
  const orig = process.env;

  beforeEach(() => {
    process.env = { ...orig };
    delete process.env.LIVE_GRID_DUAL_BROADCAST;
    delete process.env.LIVE_GRID_VERTICAL;
    delete process.env.LIVE_GRID_VERTICAL_OUTPUT;
  });

  afterEach(() => {
    process.env = orig;
  });

  test('default is single landscape — no legacy dual', () => {
    expect(isLegacyDualBroadcastEnabled()).toBe(false);
    expect(resolveVerticalStream()).toEqual({
      verticalOutput: null,
      createVerticalBroadcast: false,
      legacyDual: false,
    });
  });

  test('LIVE_GRID_DUAL_BROADCAST=on enables legacy vertical YT + encode', () => {
    process.env.LIVE_GRID_DUAL_BROADCAST = 'on';
    expect(isLegacyDualBroadcastEnabled()).toBe(true);
    expect(resolveVerticalStream()).toEqual({
      verticalOutput: null,
      createVerticalBroadcast: true,
      legacyDual: true,
    });
  });

  test('LIVE_GRID_VERTICAL=auto still enables legacy (deprecated)', () => {
    process.env.LIVE_GRID_VERTICAL = 'auto';
    expect(isLegacyDualBroadcastEnabled()).toBe(true);
  });

  test('LIVE_GRID_VERTICAL_OUTPUT skips auto broadcast but keeps encode leg', () => {
    process.env.LIVE_GRID_VERTICAL_OUTPUT = 'rtmp://a/live2/key';
    expect(resolveVerticalStream()).toEqual({
      verticalOutput: 'rtmp://a/live2/key',
      createVerticalBroadcast: false,
      legacyDual: true,
    });
  });

  test('explicit opts.verticalOutput wins over env', () => {
    process.env.LIVE_GRID_VERTICAL_OUTPUT = 'rtmp://env/live2/key';
    expect(resolveVerticalStream({ verticalOutput: 'rtmp://opt/live2/key' }).verticalOutput)
      .toBe('rtmp://opt/live2/key');
  });
});
