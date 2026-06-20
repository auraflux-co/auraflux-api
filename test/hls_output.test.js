'use strict';

describe('live_grid hls_output', () => {
  const orig = { ...process.env };

  afterEach(() => {
    process.env = { ...orig };
    jest.resetModules();
  });

  test('Render profile disables delete_segments by default', () => {
    delete process.env.LIVE_GRID_HLS_DELETE_SEGMENTS;
    jest.resetModules();
    const { hlsFlagsString, hlsDeleteSegmentsEnabled } = require('../lib/live_grid/hls_output');
    expect(hlsDeleteSegmentsEnabled()).toBe(true);
    expect(hlsFlagsString()).toContain('delete_segments');

    process.env.LIVE_GRID_HLS_DELETE_SEGMENTS = 'off';
    jest.resetModules();
    const off = require('../lib/live_grid/hls_output');
    expect(off.hlsDeleteSegmentsEnabled()).toBe(false);
    expect(off.hlsFlagsString()).not.toContain('delete_segments');
    expect(off.hlsFlagsString()).toContain('independent_segments');
  });
});
