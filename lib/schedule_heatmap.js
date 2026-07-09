'use strict';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Aggregate YouTube day,hour rows into Mon–Sun × 0–23 grid. */
function buildDayHourGrid(rows = []) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const r of rows) {
    const dayStr = String(r.day || '').slice(0, 10);
    if (!dayStr) continue;
    const dow = new Date(`${dayStr}T12:00:00Z`).getUTCDay();
    const dowMon = (dow + 6) % 7;
    const h = Number(r.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    grid[dowMon][h] += Number(r.estimatedMinutesWatched || r.views || 0);
  }
  return grid;
}

function topPublishSlots(grid, { limit = 5 } = {}) {
  const slots = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      slots.push({ day: d, dayLabel: DAY_LABELS[d], hour: h, score: grid[d][h] });
    }
  }
  return slots
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({
      ...s,
      label: `${s.dayLabel} ${String(s.hour).padStart(2, '0')}:00 ET`,
    }));
}

function normalizeHeatmap(grid) {
  const flat = grid.flat();
  const max = Math.max(...flat, 1);
  return grid.map((row, day) => row.map((score, hour) => ({
    day,
    dayLabel: DAY_LABELS[day],
    hour,
    score,
    intensity: Math.round((score / max) * 100),
  })));
}

module.exports = {
  DAY_LABELS,
  buildDayHourGrid,
  topPublishSlots,
  normalizeHeatmap,
};
