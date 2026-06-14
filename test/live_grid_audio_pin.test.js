/**
 * CPD-970: a manual audio pin must release to auto when the pinned quadrant
 * goes slate — previously the slate-bailout skipped manual mode, leaving dead air.
 */
const { LiveGridManager } = require('../lib/live_grid/manager');

function makeManager(lastLive) {
  const mgr = new LiveGridManager({ log: () => {} });
  mgr.running = true;
  mgr.feeders = { applyAssignments: jest.fn() };
  mgr.poller = { lastLive };
  mgr.master = { setAudioQuad: jest.fn(() => true), restart: jest.fn() };
  return mgr;
}

afterEach(() => jest.clearAllTimers());

test('manual pin releases to auto when pinned quadrant goes slate', () => {
  jest.useFakeTimers();
  const mgr = makeManager({ alpha: 100, bravo: 500 });

  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'manual'); // pin quad 1 (alpha)
  expect(mgr.audioMode).toBe('manual');
  expect(mgr.audioQuad).toBe(0);

  // alpha goes offline → quad 1 becomes slate
  mgr._onAssignments([null, 'bravo', null, null]);

  expect(mgr.audioMode).toBe('auto');     // pin released
  expect(mgr.audioQuad).toBe(1);          // moved to the live quadrant
  clearTimeout(mgr._restartTimer);
  jest.useRealTimers();
});

test('manual pin holds while the pinned quadrant is still live', () => {
  jest.useFakeTimers();
  const mgr = makeManager({ alpha: 100, bravo: 500 });

  mgr._lastAssignments = ['alpha', 'bravo', null, null];
  mgr.setAudio(0, 'manual');

  // bravo has more viewers but alpha is still live — pin must hold
  mgr._onAssignments(['alpha', 'bravo', null, null]);

  expect(mgr.audioMode).toBe('manual');
  expect(mgr.audioQuad).toBe(0);
  clearTimeout(mgr._restartTimer);
  jest.useRealTimers();
});

test('manual audio pin works on url/event feed quadrant', () => {
  const mgr = makeManager({ alpha: 100 });
  mgr.feeders = {
    quads: [{ kind: 'url', label: 'EVENT', feedUrl: 'https://www.twitch.tv/ishowspeed' }, { kind: 'channel' }],
    status: () => [{ displayName: 'EVENT · ishowspeed', kind: 'url' }],
  };
  mgr._lastAssignments = [null, 'alpha', null, null];
  expect(mgr.setAudio(0, 'manual')).toBe(true);
  expect(mgr.audioQuad).toBe(0);
  expect(mgr.audioMode).toBe('manual');
});

test('all quadrants slate: pin stays (nowhere to move) without crashing', () => {
  jest.useFakeTimers();
  const mgr = makeManager({});

  mgr._lastAssignments = ['alpha', null, null, null];
  mgr.setAudio(0, 'manual');

  mgr._onAssignments([null, null, null, null]);

  expect(mgr.audioQuad).toBe(0); // unchanged — nothing live to switch to
  clearTimeout(mgr._restartTimer);
  jest.useRealTimers();
});
