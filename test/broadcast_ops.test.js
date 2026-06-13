const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildOpsSnapshot,
  listEligibleGridFiles,
  arm24hMeasurement,
} = require('../lib/broadcast/ops');

describe('broadcast ops', () => {
  test('buildOpsSnapshot flags grid live as blocker', () => {
    const snap = buildOpsSnapshot({ gridRunning: true, persistedJobs: {} });
    expect(snap.gridLive).toBe(true);
    expect(snap.safeToRestart).toBe(false);
    expect(snap.blockers[0]).toMatch(/Live Grid/);
  });

  test('buildOpsSnapshot counts active jobs', () => {
    const snap = buildOpsSnapshot({
      persistedJobs: {
        a: { stage: 'gate2' },
        b: { stage: 'published' },
      },
    });
    expect(snap.activeJobs).toBe(1);
  });

  test('listEligibleGridFiles returns sorted array', () => {
    const files = listEligibleGridFiles();
    expect(Array.isArray(files)).toBe(true);
    if (files.length >= 2) {
      expect(files[0].mtime).toBeGreaterThanOrEqual(files[1].mtime);
    }
  });
});
