'use strict';

describe('go_live_template applyGoLiveDefaults', () => {
  const orig = { ...process.env };

  afterEach(() => {
    process.env = { ...orig };
    jest.resetModules();
  });

  test('defaults to autopilot and createListing false when env listing exists', () => {
    process.env.LIVE_GRID_BROADCAST_ID = 'abc123';
    process.env.LIVE_GRID_TRUST_ENV_BROADCAST = 'on';
    const { applyGoLiveDefaults } = require('../lib/live_grid/go_live_template');
    const out = applyGoLiveDefaults({});
    expect(out.autoPilot).toBe(true);
    expect(out.operatorMode).toBe(false);
    expect(out.createListing).toBe(false);
  });
});
