'use strict';

const {
  soloFocusSeat,
  soloSeatActive,
  mainGridEncodeEnabled,
  applySoloSeatEncodeOverrides,
} = require('../lib/live_grid/solo_focus');
const { soloOutputDims } = require('../lib/live_grid/solo_publishers');

describe('solo_focus', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  test('soloSeatActive respects LIVE_GRID_SOLO_FOCUS', () => {
    process.env.LIVE_GRID_SOLO_FOCUS = '4';
    expect(soloSeatActive(0)).toBe(false);
    expect(soloSeatActive(3)).toBe(true);
    delete process.env.LIVE_GRID_SOLO_FOCUS;
    expect(soloSeatActive(0)).toBe(true);
  });

  test('mainGridEncodeEnabled defaults on', () => {
    delete process.env.LIVE_GRID_MAIN_ENCODE;
    expect(mainGridEncodeEnabled()).toBe(true);
    process.env.LIVE_GRID_MAIN_ENCODE = 'off';
    expect(mainGridEncodeEnabled()).toBe(false);
  });

  test('heroSoloEncodeDefaults matches YouTube 1080p recommendation', () => {
    const { heroSoloEncodeDefaults } = require('../lib/live_grid/solo_focus');
    expect(heroSoloEncodeDefaults().bitrateK).toBe(6800);
  });
});
