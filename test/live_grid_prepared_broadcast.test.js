const fs = require('fs');
const path = require('path');
const {
  inPrepareWindow,
  gridStartIsoFromMinutes,
  preparedIsStale,
  scheduledStartReady,
  savePrepared,
  clearPrepared,
  loadPrepared,
  PREPARED_PATH,
} = require('../lib/live_grid/prepared_broadcast');

const GRID = { start: 18 * 60, end: 3 * 60 };

describe('inPrepareWindow', () => {
  test('30 min before 6pm grid open', () => {
    expect(inPrepareWindow(17 * 60 + 30, GRID, 30)).toBe(true);
    expect(inPrepareWindow(17 * 60 + 29, GRID, 30)).toBe(false);
    expect(inPrepareWindow(18 * 60, GRID, 30)).toBe(false);
  });

  test('custom ahead minutes', () => {
    expect(inPrepareWindow(11 * 60 + 45, { start: 12 * 60, end: 18 * 60 }, 15)).toBe(true);
    expect(inPrepareWindow(12 * 60, { start: 12 * 60, end: 18 * 60 }, 15)).toBe(false);
  });
});

describe('gridStartIsoFromMinutes', () => {
  test('returns ISO string', () => {
    const iso = gridStartIsoFromMinutes(18 * 60, new Date('2026-06-13T12:00:00Z'));
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('prepared state file', () => {
  const backup = fs.existsSync(PREPARED_PATH) ? fs.readFileSync(PREPARED_PATH, 'utf8') : null;

  afterEach(() => {
    if (backup != null) fs.writeFileSync(PREPARED_PATH, backup);
    else clearPrepared();
  });

  test('save and load round-trip', () => {
    savePrepared({
      broadcastId: 'abc123',
      watchUrl: 'https://youtube.com/watch?v=abc123',
      streamId: 'stream1',
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/key',
      scheduledStartTime: '2026-06-13T22:00:00.000Z',
    });
    const loaded = loadPrepared();
    expect(loaded.broadcastId).toBe('abc123');
    expect(loaded.rtmpUrl).toContain('rtmp');
  });

  test('preparedIsStale rejects old saves', () => {
    expect(preparedIsStale({ savedAt: new Date().toISOString() })).toBe(false);
    expect(preparedIsStale({ savedAt: new Date(Date.now() - 7 * 3600000).toISOString() })).toBe(true);
  });

  test('scheduledStartReady respects slack', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(scheduledStartReady({ scheduledStartTime: future }, 5 * 60 * 1000)).toBe(false);
    const soon = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    expect(scheduledStartReady({ scheduledStartTime: soon }, 5 * 60 * 1000)).toBe(true);
  });
});
