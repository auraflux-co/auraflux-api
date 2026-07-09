'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildDayHourGrid, topPublishSlots, normalizeHeatmap } = require('../lib/schedule_heatmap');

describe('schedule_heatmap', () => {
  it('aggregates rows into day×hour grid', () => {
    const grid = buildDayHourGrid([
      { day: '2026-07-07', hour: 18, estimatedMinutesWatched: 100 },
      { day: '2026-07-08', hour: 18, estimatedMinutesWatched: 50 },
    ]);
    assert.equal(grid.flat().reduce((sum, n) => sum + n, 0), 150);
    const tue = (new Date('2026-07-07T12:00:00Z').getUTCDay() + 6) % 7;
    assert.equal(grid[tue][18], 100);
  });

  it('returns top publish slots', () => {
    const grid = buildDayHourGrid([
      { day: '2026-07-07', hour: 20, estimatedMinutesWatched: 200 },
      { day: '2026-07-07', hour: 9, estimatedMinutesWatched: 10 },
    ]);
    const top = topPublishSlots(grid, { limit: 1 });
    assert.equal(top.length, 1);
    assert.equal(top[0].hour, 20);
  });

  it('normalizes intensity 0–100', () => {
    const grid = [[0, 50], [100, 25]];
    const norm = normalizeHeatmap(grid);
    assert.equal(norm[1][0].intensity, 100);
    assert.equal(norm[0][1].intensity, 50);
  });
});
